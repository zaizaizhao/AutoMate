import { RunnableConfig } from "@langchain/core/runnables";
import { Command, MessagesAnnotation } from "@langchain/langgraph";
import { getJsonWriterTools } from "src/app/mcp-servers/mcp-client.js";
import { ToolMessage } from "@langchain/core/messages";

export async function WriteToJson(
  state: typeof MessagesAnnotation.State,
  _config: RunnableConfig,
): Promise<Command> {
    const tools = await getJsonWriterTools();
    console.log("Available tools:", tools);
    
    // 获取最后一条消息（来自ToolMessageExtract的输出）
    const lastMessage = state.messages[state.messages.length - 1];
    console.log("Processing message from ToolMessageExtract:", lastMessage.content);
    
    let updatedMessages = [...state.messages];
    
    // 直接解析ToolMessageExtract输出的标准化JSON格式
    let extractedData;
    try {
        if (typeof lastMessage.content === 'string') {
            // 清理可能的markdown格式和换行符
            let cleanContent = lastMessage.content
                .replace(/```json\s*/g, '')
                .replace(/```\s*/g, '')
                .trim();
            extractedData = JSON.parse(cleanContent);
        } else {
            throw new Error("Message content is not a string");
        }
        
        // 验证必需字段
        if (!extractedData.filePath || !extractedData.data || !extractedData.mode) {
            throw new Error("Missing required fields: filePath, data, or mode");
        }
        
        // 验证filePath格式
        if (!extractedData.filePath.endsWith('.json')) {
            throw new Error("filePath must end with .json extension");
        }
        
        // 验证mode值
        if (extractedData.mode !== 'append' && extractedData.mode !== 'overwrite') {
            throw new Error("mode must be either 'append' or 'overwrite'");
        }
        
        console.log("Parsed extracted data:", extractedData);
        
    } catch (parseError) {
        console.error("Failed to parse ToolMessageExtract output:", parseError);
        const errorMessage = new ToolMessage({
            content: `Error: Failed to parse ToolMessageExtract output - ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            tool_call_id: 'parse-error',
        });
        updatedMessages.push(errorMessage);
        
        return new Command({
            update: {
                messages: updatedMessages,
            },
            goto: "END",
        });
    }
    
    // 直接使用解析出的数据调用writeJsonFile工具
    try {
        // 查找writeJsonFile工具
        const writeJsonTool = tools.find(t => t.name === 'writeJsonFile');
        if (!writeJsonTool) {
            throw new Error("writeJsonFile tool not found");
        }
        
        console.log(`Executing writeJsonFile tool with args:`, extractedData);
        
        // 执行工具
        const toolResult = await writeJsonTool.invoke(extractedData);
        console.log(`Tool result:`, toolResult);
        
        // 创建工具消息
        const toolMessage = new ToolMessage({
            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            tool_call_id: 'writeJsonFile-direct',
        });
        
        updatedMessages.push(toolMessage);
        
    } catch (error) {
        console.error(`Error executing writeJsonFile tool:`, error);
        const errorMessage = new ToolMessage({
            content: `Error executing writeJsonFile tool: ${error instanceof Error ? error.message : String(error)}`,
            tool_call_id: 'writeJsonFile-error',
        });
        updatedMessages.push(errorMessage);
    }
    
    return new Command({
        update: {
            messages: updatedMessages,
        },
        goto:"END",
    })
}