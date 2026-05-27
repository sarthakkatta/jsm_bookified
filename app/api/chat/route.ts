import { genAI } from "@/lib/gemini";
import { searchBookSegments } from "@/lib/actions/book.actions";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { question, bookId, history } = body;

    if (!bookId) {
      return NextResponse.json({
        success: false,
        error: "Missing bookId",
      }, { status: 400 });
    }

    if (!question) {
      return NextResponse.json({
        success: false,
        error: "Missing question",
      }, { status: 400 });
    }

    // Retrieve relevant context segments from MongoDB
    const searchResult = await searchBookSegments(bookId, question, 5);
    
    let context = "";
    if (searchResult.success && searchResult.data && searchResult.data.length > 0) {
      context = searchResult.data
        .map((segment: any) => segment.content)
        .join("\n\n");
    }

    // Initialize the model with custom system instructions optimized for audio/voice tutoring
    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      systemInstruction: `You are an AI Book Tutor. You are helping a user understand the contents of their uploaded book or PDF.
Use the provided book context to answer the user's questions.
Keep your responses short, conversational, and clear (typically 2-4 sentences max), because they will be read aloud by the browser's Text-to-Speech API. Do not use markdown like lists, headers, or bold text. State the answers directly as natural spoken text.`,
    });

    // Format the chat history to Gemini's format (user/model)
    const formattedHistory = (history || [])
      .filter((msg: any) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg: any) => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      }));

    // Start a chat session with the conversation history
    const chat = model.startChat({
      history: formattedHistory,
    });

    // Construct the prompt combining book context and the user's question
    const prompt = `BOOK CONTEXT:
${context || "No matching content found in the book."}

USER QUESTION:
${question}`;

    const result = await chat.sendMessage(prompt);
    const answer = result.response.text();

    return NextResponse.json({
      success: true,
      answer,
    });
  } catch (error) {
    console.error("Gemini Chat API Error:", error);

    return NextResponse.json({
      success: false,
      error: "Something went wrong generating the response",
    }, { status: 500 });
  }
}