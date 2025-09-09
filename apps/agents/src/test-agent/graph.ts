import { AIMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { ConfigurationSchema, ensureConfiguration } from "./configuration.js";
import { getTools } from "../app/mcp-servers/mcp-client.js";
import { loadChatModel } from "./utils.js";

// Define the function that calls the model
async function callModel(
  state: typeof MessagesAnnotation.State,
  config: RunnableConfig
): Promise<typeof MessagesAnnotation.Update> {
  const configuration = ensureConfiguration(config);
  const tools = await getTools();
  console.log("Available tools:", tools);

  const model = (await loadChatModel(configuration.model)).bindTools(tools);
  const response = await model.invoke([
    {
      role: "system",
      content: configuration.systemPromptTemplate.replace(
        "{system_time}",
        new Date().toISOString()
      ),
    },
    ...state.messages,
  ]);
  return { messages: [response] };
}

// Define the function that determines whether to continue or not
function routeModelOutput(state: typeof MessagesAnnotation.State): string {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];
  // If the LLM is invoking tools, route there.
  if ((lastMessage as AIMessage)?.tool_calls?.length || 0 > 0) {
    return "tools";
  }
  // Otherwise end the graph.
  else {
    return "__end__";
  }
}

// 导出子图，用于构建graph
export async function generateGraph() {
  const tools = await getTools();
  // Define a new graph. We use the prebuilt MessagesAnnotation to define state:
  // https://langchain-ai.github.io/langgraphjs/concepts/low_level/#messagesannotation
  const workflow = new StateGraph(MessagesAnnotation, ConfigurationSchema)
    // Define the two nodes we will cycle between
    .addNode("callModel", callModel)
    .addNode("tools", new ToolNode(tools))
    // Set the entrypoint as `callModel`
    // This means that this node is the first one called
    .addEdge("__start__", "callModel")
    // .addEdge("callModel","__end__")
    .addConditionalEdges(
      // First, we define the edges' source node. We use `callModel`.
      // This means these are the edges taken after the `callModel` node is called.
      "callModel",
      // Next, we pass in the function that will determine the sink node(s), which
      // will be called after the source node is called.
      routeModelOutput
    )
    .addEdge("tools", "callModel")
    .addEdge("callModel", "__end__");
  return workflow;
}

// Initialize graph at module load time
const graphPromise = (await generateGraph()).compile({
  interruptBefore: [], // if you want to update the state before calling the tools
  interruptAfter: [],
});

// Export graph that's initialized at startup
export const graph = await graphPromise;
