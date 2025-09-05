import { initChatModel } from "langchain/chat_models/universal";
/**
 * Load a chat model from a fully specified name.
 * @param fullySpecifiedName - String in the format 'provider/model' or 'provider/account/provider/model'.
 * @returns A Promise that resolves to a BaseChatModel instance.
 */
export async function loadChatModel(
  fullySpecifiedName: string,
): Promise<ReturnType<typeof initChatModel>> {
  const index = fullySpecifiedName.indexOf("/");
  if (index === -1) {
    // If there's no "/", assume it's just the model
    return await initChatModel(fullySpecifiedName);
  } else {
    const provider = fullySpecifiedName.slice(0, index);
    const model = fullySpecifiedName.slice(index + 1);
    console.log("this is provider and model", provider, model);
    console.log("this is openai api base url", process.env.OPENAI_API_BASE_URL);
    console.log("this is openai api key", process.env.OPENAI_API_KEY);
    // Handle different providers
    if (provider === "openai") {
      console.log("进入openai初始化");
      console.log("this is openai api base url", process.env.OPENAI_API_BASE_URL);
      console.log("this is openai api key", process.env.OPENAI_API_KEY);
      return await initChatModel(model, {
        modelProvider: "openai",
        configuration: {
          baseURL: process.env.OPENAI_API_BASE_URL,
        },
        modelKwargs: {
          stream_options: { include_usage: false }
        },
      });
    } else {
      console.log("进入其他模型初始化");
      return await initChatModel(model, {
        modelKwargs: {
          stream_options: { include_usage: false }
        },
        modelProvider: provider,
      });
    }
  }
}
