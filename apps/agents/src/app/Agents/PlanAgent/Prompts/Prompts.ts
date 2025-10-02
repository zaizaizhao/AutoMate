/**
 * 构建数据评估提示词
 * 用于评估数据库数据是否足够生成有意义的测试任务
 * 
 * @param tool - 工具信息对象，包含名称、描述和参数模式
 * @param queryResults - 数据库查询结果
 * @param currentRound - 当前查询轮次
 * @returns 数据评估提示词字符串
 */
export function buildDataAssessmentPrompt(
  tool: any,
  queryResults: Record<string, any>,
  currentRound: number
): string {
  const toolSchema = tool?.schema ?? tool?.input_schema ?? tool?.parametersSchema ?? {};
  const properties = toolSchema.properties || {};

  return `You are a data sufficiency analyst. Evaluate whether the provided database data is sufficient to generate a meaningful test task for the given tool.
    TOOL INFORMATION:
    Name: ${tool.name}
    Description: ${tool.description || 'No description'}
    Parameters: ${JSON.stringify(properties, null, 2)}

    AVAILABLE DATA:
    ${JSON.stringify(queryResults, null, 2)}

    CURRENT QUERY ROUND: ${currentRound}

    EVALUATION CRITERIA:
    1. Are there sufficient real data records to populate tool parameters?
    2. Do the available data types match the tool's parameter requirements?
    3. Is there enough variety in the data for meaningful testing?
    4. Are there any critical missing data types that would prevent effective testing?

    RETURN A JSON OBJECT WITH:
    {
    "isDataSufficient": boolean,
    "missingData": ["list of missing data types or tables"],
    "assessmentReason": "detailed explanation of the assessment",
    "confidence": number (0-1, confidence in the assessment)
    }

    Be strict in your assessment - only mark as sufficient if you can generate a realistic, meaningful test with actual data.`;
}