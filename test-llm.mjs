import { invokeLLM } from "./server/_core/llm.ts";

try {
  console.log("Testing LLM API...");
  const response = await invokeLLM({
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Say 'Hello, world!' in one sentence." },
    ],
  });
  console.log("✅ LLM call succeeded!");
  console.log("Response:", response.choices[0].message.content);
} catch (error) {
  console.error("❌ LLM call failed:");
  console.error("Error code:", error.code || error.status);
  console.error("Error message:", error.message);
  if (error.response?.data) {
    console.error("API response:", error.response.data);
  }
}
