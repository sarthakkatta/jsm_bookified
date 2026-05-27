import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GOOGLE_GEMINI_API_KEY;

if (!apiKey) {
  console.warn("WARNING: GOOGLE_GEMINI_API_KEY is not defined in environment variables.");
}

export const genAI = new GoogleGenerativeAI(apiKey || "");

export const model = genAI.getGenerativeModel({
  model: "gemini-3.5-flash",
});