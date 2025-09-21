# PlanAgent 两阶段架构设计

## 问题分析

当前PlanAgent存在的问题：
1. **约束冲突**：sqlToolPrompts要求LLM查询真实数据库ID，但outputRules严格限制输出格式，导致LLM可能跳过工具调用直接生成mock数据
2. **响应解析局限**：只取最后一条消息content，可能错过工具调用过程中获取的真实数据
3. **提示优先级混乱**：格式约束可能覆盖数据查询指导

## 两阶段架构设计

### 第一阶段：数据查询规划阶段 (Data Query & Planning Stage)

**目标**：让LLM自由调用数据库工具，进行数据探索和分析，无格式约束

**特点**：
- 使用sqlToolPrompts指导，鼓励LLM查询真实数据
- 无严格的JSON输出格式要求
- 允许自然语言描述和工具调用
- 重点关注数据获取和任务理解

**输入**：
- 用户需求
- 当前批次工具信息
- sqlToolPrompts（数据库查询指导）
- 宽松的输出要求（允许自然语言+工具调用）

**输出**：
- 工具调用历史和结果
- 自然语言形式的任务规划思路
- 获取到的真实数据库ID和相关信息

### 第二阶段：格式化阶段 (Formatting Stage)

**目标**：基于第一阶段的数据查询结果，生成符合outputRules的结构化JSON

**特点**：
- 严格遵循outputRules格式要求
- 使用第一阶段获取的真实数据
- 专注于结构化输出，不进行新的工具调用
- 确保所有任务使用真实的数据库ID

**输入**：
- 第一阶段的完整对话历史
- 第一阶段获取的真实数据
- 严格的outputRules
- 当前批次信息

**输出**：
- 符合outputRules的结构化JSON
- 包含真实数据库ID的任务列表

## 实现方案

### 1. 创建两个独立的Agent实例

```typescript
// 第一阶段：数据查询Agent
const dataQueryAgent = await createReactAgent({
  llm: this.llm,
  tools: await getPostgresqlHubTools() // 完整的数据库工具集
});

// 第二阶段：格式化Agent
const formattingAgent = await createReactAgent({
  llm: this.llm,
  tools: [] // 不提供工具，专注格式化
});
```

### 2. 分阶段提示设计

**第一阶段提示**：
- 强调数据查询的重要性
- 鼓励使用工具获取真实数据
- 允许自然语言输出
- 不强制JSON格式

**第二阶段提示**：
- 基于第一阶段结果进行格式化
- 严格遵循JSON输出格式
- 禁止生成新数据，只使用已获取的真实数据

### 3. 数据传递机制

```typescript
// 第一阶段执行
const stage1Response = await dataQueryAgent.invoke({
  messages: stage1Messages
});

// 提取第一阶段的完整对话历史
const stage1History = extractFullConversationHistory(stage1Response);
const realData = extractRealDataFromHistory(stage1History);

// 第二阶段执行
const stage2Response = await formattingAgent.invoke({
  messages: [
    ...stage2SystemPrompts,
    { role: "user", content: `基于以下数据查询结果，生成符合格式的任务JSON：\n${JSON.stringify(stage1History, null, 2)}` }
  ]
});
```

### 4. 错误处理和回退机制

- 如果第一阶段未获取到足够数据，提供明确的错误信息
- 如果第二阶段格式化失败，可以重试或使用默认格式
- 保持向后兼容，确保现有功能不受影响

## 优势

1. **解决约束冲突**：两个阶段各司其职，避免相互干扰
2. **提高数据质量**：第一阶段专注获取真实数据，避免mock数据
3. **增强可维护性**：逻辑分离，便于调试和优化
4. **保持灵活性**：可以独立调整每个阶段的行为
5. **向后兼容**：保持现有的批次处理和任务持久化逻辑

## 实施步骤

1. 实现第一阶段：数据查询规划方法
2. 实现第二阶段：格式化方法
3. 修改planNode方法，整合两阶段调用
4. 测试和验证功能
5. 性能优化和错误处理完善