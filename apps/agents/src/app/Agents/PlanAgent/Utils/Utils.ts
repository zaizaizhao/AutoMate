/**
 * 从LLM响应中解析JSON数据
 * 
 * 该函数处理LLM返回的响应，提取其中的JSON内容并解析为JavaScript对象。
 * 支持处理包含markdown代码块的响应格式。
 * 
 * @param response - LLM响应对象，可能包含content属性或直接为响应内容
 * @returns 解析后的JSON对象，如果解析失败则抛出错误
 * @throws {Error} 当JSON解析失败时抛出错误
 * 
 * @example
 * ```typescript
 * const response = { content: '```json\n{"key": "value"}\n```' };
 * const parsed = parseJsonFromLLMResponse(response);
 * console.log(parsed); // { key: "value" }
 * ```
 */
export function parseJsonFromLLMResponse(response: any): any {
  const content = response.content || response;
  let text = typeof content === 'string' ? content : JSON.stringify(content);
  text = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();
  return JSON.parse(text);
}

/**
 * 解析SQL查询结果 - 处理JSON字符串格式的响应
 * 
 * 该函数处理SQL工具返回的结果，支持JSON字符串格式的响应解析。
 * 如果结果是JSON字符串且包含success和data字段，会提取data中的rows或data本身。
 * 
 * @param result - SQL工具返回的结果，可能是字符串、对象或其他类型
 * @returns 解析后的数据或原始结果
 * 
 * @example
 * ```typescript
 * // JSON字符串格式
 * const result1 = '{"success": true, "data": {"rows": [{"id": 1}]}}';
 * const parsed1 = parseSqlResult(result1);
 * console.log(parsed1); // [{"id": 1}]
 * 
 * // 普通对象
 * const result2 = {id: 1, name: "test"};
 * const parsed2 = parseSqlResult(result2);
 * console.log(parsed2); // {id: 1, name: "test"}
 * ```
 */
export function parseSqlResult(result: any): any {
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      // 如果解析成功且有success和data字段，返回data中的rows
      if (parsed && typeof parsed === 'object' && parsed.success && parsed.data) {
        return parsed.data.rows || parsed.data;
      }
      // 否则返回整个解析结果
      return parsed;
    } catch (error) {
      console.warn('[Utils] Failed to parse SQL result as JSON:', error);
      return result;
    }
  }
  return result;
}