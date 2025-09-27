# PlanAgent 优化方案

## 1. 现状分析

### 1.1 当前架构概述

当前的 PlanAgent 采用以下架构：

```
START → plan-node → takeActionOrGeneratePlan → [plan-node | END]
```

- **单一节点设计**：只有一个 `plan-node` 节点处理所有逻辑
- **ReactAgent 集成**：使用 `createReactAgent` 包装 LLM 和数据库工具
- **批量处理**：每次生成 5 个测试计划任务

### 1.2 当前实现特点

1. **ReactAgent 使用**：
   - 使用 `createReactAgent` 创建具有工具调用能力的代理
   - 集成了 PostgreSQL 数据库工具 (`postgresql-hub`)
   - 通过提示词指导 LLM 进行两阶段工作：数据查询 → 计划生成

2. **批量生成机制**：
   - 每个批次处理 5 个工具
   - 一次性生成 5 个测试计划
   - 通过复杂的 JSON 解析逻辑处理 LLM 响应

3. **状态管理**：
   - 使用 SharedMemoryManager 或 LangGraph Store 管理批次状态
   - 通过 `batchIndex` 跟踪当前处理进度

## 2. 问题识别

### 2.1 核心问题

#### 2.1.1 SQL 工具调用不精准
- **问题描述**：ReactAgent 虽然具备工具调用能力，但无法保证每次都精准调用 SQL 工具
- **影响**：
  - 可能跳过数据库查询步骤，直接生成计划
  - 生成的测试参数可能使用模拟数据而非真实数据
  - 测试计划质量不稳定

#### 2.1.2 批量生成增加 LLM 负担
- **问题描述**：一次性生成 5 个测试计划对 LLM 造成过重负担
- **影响**：
  - 响应时间长，影响用户体验
  - 复杂的多任务处理容易出错
  - JSON 解析复杂，容易失败
  - 难以保证每个计划的质量一致性

#### 2.1.3 架构复杂性
- **问题描述**：单一节点承担过多职责
- **影响**：
  - 代码逻辑复杂，难以维护
  - 错误处理困难
  - 难以进行单元测试
  - 扩展性差

### 2.2 具体表现

1. **不可控的工具调用**：
   ```typescript
   // 当前方式：依赖 ReactAgent 自主决策
   const response = await planReactAgent.invoke({
     messages: [
       { role: "system", content: unifiedPrompts },
       { role: "user", content: "Generate test tasks..." }
     ]
   });
   ```

2. **复杂的响应解析**：
   ```typescript
   // 需要处理多种响应格式
   let msgs: any[] = [];
   if (response && Array.isArray((response as any).messages)) {
     msgs = (response as any).messages as any[];
   } else if (response && (response as any).content) {
     msgs = [response as any];
   }
   ```

3. **批量处理的复杂性**：
   - 需要处理 5 个不同工具的计划生成
   - 复杂的 JSON 结构验证
   - 批次状态管理复杂

## 3. 优化方案

### 3.1 架构重构

#### 3.1.1 新架构设计

```
START → data-query-node → plan-generation-node → route-decision → [data-query-node | plan-generation-node | END]
```

**节点职责分离**：
1. **data-query-node**：专门负责数据库查询
2. **plan-generation-node**：专门负责单个计划生成
3. **route-decision**：智能路由决策

#### 3.1.2 详细节点设计

##### Data Query Node
```typescript
async dataQueryNode(
  state: typeof MessagesAnnotation.State,
  config: LangGraphRunnableConfig
) {
  // 1. 获取当前需要处理的工具信息
  // 2. 构建针对性的 SQL 查询
  // 3. 执行数据库查询
  // 4. 将查询结果存储到状态中
}
```

**特点**：
- 专注于数据查询逻辑
- 使用确定性的工具调用，而非依赖 ReactAgent
- 查询结果结构化存储

##### Plan Generation Node
```typescript
async planGenerationNode(
  state: typeof MessagesAnnotation.State,
  config: LangGraphRunnableConfig
) {
  // 1. 从状态中获取查询到的数据
  // 2. 获取当前工具的 schema 信息
  // 3. 生成单个测试计划
  // 4. 验证并存储计划
}
```

**特点**：
- 专注于单个计划生成
- 使用简化的 LLM 调用，无需 ReactAgent
- 输入输出明确，易于测试

##### Route Decision
```typescript
async routeDecision(
  state: typeof MessagesAnnotation.State,
  config: LangGraphRunnableConfig
): Promise<"data-query-node" | "plan-generation-node" | typeof END> {
  // 1. 检查当前工具是否已查询数据
  // 2. 检查当前工具是否已生成计划
  // 3. 检查是否还有未处理的工具
  // 4. 返回下一步路由
}
```

### 3.2 实现策略

#### 3.2.1 单工具处理模式

**从批量处理改为单工具处理**：
- 每次只处理一个工具的计划生成
- 简化 LLM 任务复杂度
- 提高生成质量和稳定性

#### 3.2.2 确定性工具调用

**替换 ReactAgent 为直接工具调用**：
```typescript
// 当前方式（不可控）
const planReactAgent = await createReactAgent({
  llm: this.llm,
  tools: dbTools
});

// 优化方式（可控）
const dbTools = await getPostgresqlHubTools();
const sqlTool = dbTools.find(tool => tool.name === 'postgresql-hub');
const queryResult = await sqlTool.invoke({
  query: constructedQuery
});
```

#### 3.2.3 状态管理优化

**引入更细粒度的状态管理**：
```typescript
interface PlanAgentState {
  currentToolIndex: number;
  currentTool: ToolMeta;
  queryResults: Record<string, any>;
  generatedPlans: TaskPlanedForTest[];
  batchInfo: BatchInfo;
}
```

### 3.3 具体实现步骤

#### 步骤 1：创建新的状态注解
```typescript
const PlanAgentAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  currentToolIndex: Annotation<number>,
  currentTool: Annotation<ToolMeta>,
  queryResults: Annotation<Record<string, any>>,
  generatedPlans: Annotation<TaskPlanedForTest[]>,
  batchInfo: Annotation<BatchInfo>
});
```

#### 步骤 2：实现数据查询节点
```typescript
async dataQueryNode(
  state: typeof PlanAgentAnnotation.State,
  config: LangGraphRunnableConfig
) {
  const { currentTool } = state;
  
  // 构建查询策略
  const queryStrategy = this.buildQueryStrategy(currentTool);
  
  // 执行查询
  const dbTools = await getPostgresqlHubTools();
  const results = await this.executeQueries(dbTools, queryStrategy);
  
  // 更新状态
  return {
    queryResults: {
      ...state.queryResults,
      [currentTool.name]: results
    }
  };
}
```

#### 步骤 3：实现计划生成节点
```typescript
async planGenerationNode(
  state: typeof PlanAgentAnnotation.State,
  config: LangGraphRunnableConfig
) {
  const { currentTool, queryResults } = state;
  const toolData = queryResults[currentTool.name];
  
  // 构建简化的提示词
  const prompt = this.buildSinglePlanPrompt(currentTool, toolData);
  
  // 调用 LLM 生成单个计划
  const response = await this.llm.invoke([
    { role: "system", content: prompt },
    { role: "user", content: `Generate a test plan for ${currentTool.name}` }
  ]);
  
  // 解析并验证计划
  const plan = this.parseSinglePlan(response.content);
  
  return {
    generatedPlans: [...state.generatedPlans, plan]
  };
}
```

#### 步骤 4：实现路由决策
```typescript
async routeDecision(
  state: typeof PlanAgentAnnotation.State,
  config: LangGraphRunnableConfig
): Promise<"data-query-node" | "plan-generation-node" | "next-tool" | typeof END> {
  const { currentToolIndex, batchInfo, queryResults, generatedPlans } = state;
  const currentTool = batchInfo.tools[currentToolIndex];
  
  // 检查当前工具状态
  const hasQueryData = queryResults[currentTool.name];
  const hasPlan = generatedPlans.some(p => p.toolName === currentTool.name);
  
  if (!hasQueryData) {
    return "data-query-node";
  }
  
  if (!hasPlan) {
    return "plan-generation-node";
  }
  
  // 检查是否还有更多工具
  if (currentToolIndex < batchInfo.tools.length - 1) {
    return "next-tool";
  }
  
  return END;
}
```

#### 步骤 5：添加工具切换节点
```typescript
async nextToolNode(
  state: typeof PlanAgentAnnotation.State,
  config: LangGraphRunnableConfig
) {
  const nextIndex = state.currentToolIndex + 1;
  const nextTool = state.batchInfo.tools[nextIndex];
  
  return {
    currentToolIndex: nextIndex,
    currentTool: nextTool
  };
}
```

#### 步骤 6：重构图构建
```typescript
public buildGraph() {
  const builder = new StateGraph(PlanAgentAnnotation)
    .addNode("data-query-node", this.dataQueryNode.bind(this))
    .addNode("plan-generation-node", this.planGenerationNode.bind(this))
    .addNode("next-tool", this.nextToolNode.bind(this))
    .addEdge(START, "data-query-node")
    .addConditionalEdges(
      "data-query-node",
      this.routeDecision.bind(this),
      {
        "plan-generation-node": "plan-generation-node",
        "next-tool": "next-tool",
        [END]: END
      }
    )
    .addConditionalEdges(
      "plan-generation-node", 
      this.routeDecision.bind(this),
      {
        "data-query-node": "data-query-node",
        "next-tool": "next-tool", 
        [END]: END
      }
    )
    .addConditionalEdges(
      "next-tool",
      this.routeDecision.bind(this),
      {
        "data-query-node": "data-query-node",
        [END]: END
      }
    );

  return builder.compile({
    checkpointer: this.memoryManager.getCheckpointer(),
    interruptBefore: [],
    interruptAfter: [],
  }).withConfig({ recursionLimit: 256 });
}
```

## 4. 优化效果预期

### 4.1 性能提升
- **响应时间**：单工具处理减少 60-80% 的响应时间
- **成功率**：确定性工具调用提高 90%+ 的成功率
- **资源消耗**：减少 LLM token 消耗 40-60%

### 4.2 质量提升
- **数据准确性**：100% 保证使用真实数据库数据
- **计划一致性**：单工具处理提高计划质量一致性
- **错误处理**：细粒度节点便于错误定位和处理

### 4.3 维护性提升
- **代码清晰度**：职责分离，代码更清晰
- **测试便利性**：每个节点可独立测试
- **扩展性**：新增功能更容易实现

## 5. 实施计划

### 5.1 第一阶段：基础重构（1-2 周）
1. 创建新的状态注解
2. 实现数据查询节点
3. 实现基础路由逻辑

### 5.2 第二阶段：核心功能（2-3 周）
1. 实现计划生成节点
2. 完善路由决策逻辑
3. 集成工具切换机制

### 5.3 第三阶段：优化完善（1 周）
1. 性能优化
2. 错误处理完善
3. 测试用例补充

### 5.4 第四阶段：验证部署（1 周）
1. 集成测试
2. 性能对比验证
3. 生产环境部署

## 6. 风险评估与缓解

### 6.1 主要风险
1. **兼容性风险**：新架构可能与现有系统不兼容
2. **性能风险**：多节点可能增加延迟
3. **复杂性风险**：路由逻辑可能过于复杂

### 6.2 缓解措施
1. **渐进式迁移**：保留原有接口，逐步切换
2. **性能监控**：实时监控性能指标
3. **简化设计**：保持路由逻辑简单明确

## 7. 总结

通过将单一的 ReactAgent 节点拆分为专门的数据查询节点和计划生成节点，并引入智能路由机制，可以显著提升 PlanAgent 的性能、稳定性和可维护性。这种架构更符合单一职责原则，便于测试和扩展，是一个值得实施的优化方案。