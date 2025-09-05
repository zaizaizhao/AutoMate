import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ConfigurationSchema } from "./configuration.js";
import { ToolMessageExtract } from "./toolMessageExtract.js";
import { WriteToJson } from "./writeToJson.js";

const workflow = new StateGraph(MessagesAnnotation,ConfigurationSchema)
   .addNode("tool-message-extract", ToolMessageExtract)
   .addNode("write-to-json", WriteToJson)
   .addEdge(START, "tool-message-extract")
   .addEdge("tool-message-extract", "write-to-json")
   .addEdge("write-to-json", END)
  // .addNode("classify-message", classifyMessage, {
  //   ends: [END, "start-planner", "create-new-session"],
  // })
  // .addNode("create-new-session", createNewSession)
  // .addNode("start-planner", startPlanner)
  // .addEdge(START, "initialize-github-issue")
  // .addEdge("initialize-github-issue", "classify-message")
  // .addEdge("create-new-session", END)
  // .addEdge("start-planner", END);

export const graph = workflow.compile();
graph.name = "AutoMete";
