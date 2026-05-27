const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI("AIzaSyB0mpWeAzQTpmsTSjy-me7s83YIyy7I3L0");

async function run() {
  const model = genAI.getGenerativeModel({
    model: "models/gemini-1.5-flash",
  });

  const result = await model.generateContent("Hello");

  console.log(result.response.text());
}

run();