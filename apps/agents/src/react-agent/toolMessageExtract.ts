import { RunnableConfig } from "@langchain/core/runnables";
import { Command, MessagesAnnotation } from "@langchain/langgraph";
import { ensureConfiguration } from "./configuration.js";
import { loadChatModel } from "./utils.js";
import { getTestServerTools } from "src/app/mcp-servers/mcp-client.js";
import { TOOL_MESSAGE_EXTRACT_PROMPT } from "./prompts.js";

// 验证输出格式的函数
function validateExtractedData(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.filePath === 'string' &&
      parsed.filePath.endsWith('.json') &&
      typeof parsed.data === 'object' &&
      parsed.data !== null &&
      (parsed.mode === 'append' || parsed.mode === 'overwrite')
    );
  } catch {
    return false;
  }
}

export async function ToolMessageExtract(
  state: typeof MessagesAnnotation.State,
  config: RunnableConfig,
): Promise<Command> {
  const configuration = ensureConfiguration(config);
  const tools = await getTestServerTools();

  const model = (await loadChatModel(configuration.model)).bindTools(tools);
  const maxRetries = 3;
  let response;
  let validResponse = false;
  let lastError = "";
  
  // 重试循环
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`ToolMessageExtract attempt ${attempt + 1}/${maxRetries + 1}`);
      
      // 构建系统提示，重试时包含更详细的格式要求
      let systemPrompt = TOOL_MESSAGE_EXTRACT_PROMPT.replace(
        "{system_time}",
        new Date().toISOString(),
      );
      
      // 如果是重试，添加更严格的格式要求和之前的错误信息
      if (attempt > 0) {
        systemPrompt += `\n\n重要提醒：之前的输出格式验证失败（${lastError}）。请严格按照以下要求输出：
1. 必须是有效的JSON格式
2. 必须包含filePath、data、mode三个字段
3. filePath必须是绝对路径且以.json结尾
4. data必须是有效的JSON对象
5. mode必须是"append"或"overwrite"
6. 不要包含任何markdown格式或额外文本
7. 直接输出JSON，不要有任何解释性文字`;
      }
      
      response = await model.invoke([
        {
          role: "system",
          content: systemPrompt,
        },
        ...state.messages,
      ]);
      
      console.log(`ToolMessageExtract response (attempt ${attempt + 1}):`, response);
      
      // 验证输出格式
      if (response.content && typeof response.content === 'string') {
        if (validateExtractedData(response.content)) {
          console.log(`ToolMessageExtract validation successful on attempt ${attempt + 1}`);
          validResponse = true;
          break;
        } else {
          lastError = `格式验证失败 - 内容: ${response.content.substring(0, 200)}...`;
          console.warn(`ToolMessageExtract validation failed on attempt ${attempt + 1}:`, lastError);
          
          // 如果不是最后一次尝试，等待一小段时间再重试
          if (attempt < maxRetries) {
            console.log(`等待500ms后进行第${attempt + 2}次重试...`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      } else {
        lastError = "响应内容为空或格式不正确";
        console.warn(`ToolMessageExtract response invalid on attempt ${attempt + 1}:`, lastError);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } catch (error) {
      lastError = `模型调用异常: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`ToolMessageExtract error on attempt ${attempt + 1}:`, error);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  // 如果所有重试都失败，使用默认格式
  if (!validResponse) {
    console.error(`ToolMessageExtract所有重试都失败，使用默认格式。最后错误: ${lastError}`);
    
    // 创建默认响应
    const defaultContent = JSON.stringify({
      filePath: "/tmp/default_output.json",
      data: {
        error: "ToolMessageExtract validation failed after all retries",
        lastError: lastError,
        originalContent: response?.content || "No content"
      },
      mode: "overwrite"
    });
    
    response = {
      content: defaultContent,
      additional_kwargs: {},
      response_metadata: {},
      tool_calls: [],
      invalid_tool_calls: []
    };
    
    console.log("使用默认响应:", response);
  }
  
  return new Command({
    // 只传递最新的消息
    update: {
      messages: [response],
    },
    goto: "write-to-json",
  })
}