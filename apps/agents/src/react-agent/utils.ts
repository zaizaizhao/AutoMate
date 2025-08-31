import { initChatModel } from "langchain/chat_models/universal";
/**
 * Load a chat model from a fully specified name.
 * @param fullySpecifiedName - String in the format 'provider/model' or 'provider/account/provider/model'.
 * @returns A Promise that resolves to a BaseChatModel instance.
 */
export async function loadChatModel(
  fullySpecifiedName: string,
): Promise<ReturnType<typeof initChatModel>> {
  console.log(fullySpecifiedName);
  
  const index = fullySpecifiedName.indexOf("/");
  if (index === -1) {
    // If there's no "/", assume it's just the model
    return await initChatModel(fullySpecifiedName);
  } else {
    const provider = fullySpecifiedName.slice(0, index);
    const model = fullySpecifiedName.slice(index + 1);
    console.log("this is provider and model",provider,model);
    
    // Handle different providers
  if (provider === "openai") {
      return await initChatModel(model, {
        modelProvider: "openai", // Local models are usually OpenAI-compatible
        baseURL: process.env.OPENAI_API_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY || "dummy-key",
      });
    } else {
      return await initChatModel(model, {
        modelProvider: provider,
      });
    }
  }
}
