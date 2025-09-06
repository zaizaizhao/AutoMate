import { MultiAgentCoordinator } from "./AgentManager/AgentManager.js";
import {PlanAgent} from "./Agents/PlanAgent/PlanAgent.js"
import { loadChatModel } from "./ModelUtils/ChatModel.js";
import { ConfigurationSchema } from "./ModelUtils/Config.js";

// const llm = await loadChatModel("openai/deepseek-ai/DeepSeek-V3");
// console.log("this is llm",llm);

const multiAgentCoordinator = new MultiAgentCoordinator()
const workflow = multiAgentCoordinator.initializeAgents()
export const graph = workflow.compile();
graph.name = "agent";
// const planAgent = new PlanAgent(ConfigurationSchema);
// const graph = new StateGraph(MessagesAnnotation, ConfigurationSchema)
// graph.name = "AutoMete";