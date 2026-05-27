'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Send, Loader2 } from 'lucide-react';
import { useUser } from '@clerk/nextjs';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { IBook, Messages } from '@/types';
import Transcript from '@/components/Transcript';
import { startVoiceSession, endVoiceSession } from '@/lib/actions/session.actions';

interface VoiceAssistantProps {
  book: IBook;
}

const VoiceAssistant = ({ book }: VoiceAssistantProps) => {
  const { user } = useUser();
  const router = useRouter();

  // Status and active session state
  const [status, setStatus] = useState<'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [isActive, setIsActive] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [isBillingError, setIsBillingError] = useState(false);

  // Transcript/Messages state
  const [messages, setMessages] = useState<Messages[]>([]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [currentUserMessage, setCurrentUserMessage] = useState('');
  const [textInput, setTextInput] = useState('');

  // Duration tracking
  const [duration, setDuration] = useState(0);
  const [maxDurationSeconds, setMaxDurationSeconds] = useState(300); // 5 mins default

  // Refs for tracking mutable states in async listeners
  const statusRef = useRef(status);
  const isActiveRef = useRef(isActive);
  const sessionIdRef = useRef<string | null>(null);
  const durationRef = useRef(duration);
  const recognitionRef = useRef<any>(null);

  // Update refs to prevent closure stale states
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // Handle billing redirect
  useEffect(() => {
    if (limitError) {
      toast.error(limitError);
      if (isBillingError) {
        router.push('/subscriptions');
      }
      setLimitError(null);
    }
  }, [limitError, isBillingError, router]);

  // Clean up speech synthesis voices changed listener
  useEffect(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      const handleVoicesChanged = () => {};
      window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
      return () => {
        window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
      };
    }
  }, []);

  // Format seconds to mm:ss
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Helper to select the correct browser voice based on the book persona
  const getBrowserVoice = useCallback((persona: string): SpeechSynthesisVoice | null => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    const isFemale = ['rachel', 'sarah'].includes(persona?.toLowerCase() || '');
    const englishVoices = voices.filter(v => v.lang.startsWith('en'));

    if (englishVoices.length === 0) return null;

    if (isFemale) {
      const femaleVoice = englishVoices.find(v =>
        v.name.toLowerCase().includes('zira') ||
        v.name.toLowerCase().includes('female') ||
        v.name.toLowerCase().includes('hazel') ||
        v.name.toLowerCase().includes('susan') ||
        v.name.toLowerCase().includes('samantha') ||
        v.name.toLowerCase().includes('google us english')
      );
      return femaleVoice || englishVoices[0];
    } else {
      const maleVoice = englishVoices.find(v =>
        v.name.toLowerCase().includes('david') ||
        v.name.toLowerCase().includes('male') ||
        v.name.toLowerCase().includes('george') ||
        v.name.toLowerCase().includes('microsoft david') ||
        v.name.toLowerCase().includes('google uk english male')
      );
      return maleVoice || englishVoices[0];
    }
  }, []);

  // Synthesize/speak response
  const speakResponse = useCallback((text: string, onEndCallback: () => void) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      onEndCallback();
      return;
    }

    // Cancel current speech if any
    window.speechSynthesis.cancel();

    // Clean up text format slightly to improve browser speech flow (removing brackets/stars)
    const cleanedText = text
      .replace(/[\*\_\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const utterance = new SpeechSynthesisUtterance(cleanedText);
    const matchedVoice = getBrowserVoice(book.persona || 'rachel');
    if (matchedVoice) {
      utterance.voice = matchedVoice;
    }

    utterance.onend = () => {
      onEndCallback();
    };

    utterance.onerror = (e) => {
      console.error('Speech synthesis utterance error:', e);
      onEndCallback();
    };

    window.speechSynthesis.speak(utterance);
  }, [book.persona, getBrowserVoice]);

  // Start listening helper
  const startListening = useCallback(() => {
    if (!isActiveRef.current) return;

    const SpeechRecognition = typeof window !== 'undefined' ? (window.SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
    if (!SpeechRecognition) {
      toast.error('Browser speech recognition not supported. You can type your questions instead!');
      return;
    }

    // Clean up previous recognition if running
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch (e) {}
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      if (isActiveRef.current) {
        setStatus('listening');
      }
    };

    recognition.onresult = (event: any) => {
      if (!isActiveRef.current) return;

      const results = event.results;
      const transcript = results[0][0].transcript;

      if (results[0].isFinal) {
        setCurrentUserMessage('');
        // Trigger query submission
        submitQuestion(transcript);
      } else {
        setCurrentUserMessage(transcript);
      }
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error event:', event.error);
      
      // If we didn't hear anything, don't crash, just restart if session is still active
      if (event.error === 'no-speech') {
        if (isActiveRef.current && statusRef.current === 'listening') {
          setTimeout(() => {
            if (isActiveRef.current && statusRef.current === 'listening') {
              try { recognition.start(); } catch (err) {}
            }
          }, 300);
        }
      } else {
        // Handle other recognition errors like network or microphone blockages
        if (event.error === 'not-allowed') {
          toast.error('Microphone permission blocked. Please enable microphone access.');
          stopSession();
        }
      }
    };

    recognition.onend = () => {
      // If recognition stopped but state is still 'listening', restart it to keep active turn-taking
      if (isActiveRef.current && statusRef.current === 'listening') {
        try { recognition.start(); } catch (err) {}
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      console.error('Failed to start speech recognition:', err);
    }
  }, [book.persona]);

  // Submit question to Gemini backend API
  const submitQuestion = async (questionText: string) => {
    if (!questionText.trim()) return;

    // Transition status to thinking
    setStatus('thinking');
    
    // Stop speech recognition while we fetch/speak the answer
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      } catch (e) {}
    }

    // Add user message to history
    const userMsg: Messages = { role: 'user', content: questionText };
    setMessages(prev => [...prev, userMsg]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question: questionText,
          bookId: book._id,
          history: [...messages, userMsg],
        }),
      });

      const data = await response.json();

      if (data.success && data.answer) {
        const assistantAnswer = data.answer;

        // Visual display of response starts
        setStatus('speaking');
        setCurrentMessage(assistantAnswer);

        // Speak the response aloud using Web Speech API
        speakResponse(assistantAnswer, () => {
          // Speak completed callback
          setMessages(prev => [...prev, { role: 'assistant', content: assistantAnswer }]);
          setCurrentMessage('');
          
          if (isActiveRef.current) {
            setStatus('listening');
            startListening();
          }
        });
      } else {
        throw new Error(data.error || 'Failed to generate tutor response');
      }
    } catch (err: any) {
      console.error('Error querying chat API:', err);
      toast.error('Sorry, I encountered an error answering that. Please try again.');
      
      if (isActiveRef.current) {
        setStatus('listening');
        startListening();
      }
    }
  };

  // Start the voice tutor session
  const startSession = async () => {
    if (!user) {
      toast.error('Please sign in to start a tutoring session.');
      return;
    }

    setStatus('connecting');
    setLimitError(null);
    setIsBillingError(false);

    try {
      // 1. Check session limit and write start session in MongoDB
      const result = await startVoiceSession(user.id, book._id);

      if (!result.success) {
        setLimitError(result.error || 'Session limit reached.');
        setIsBillingError(!!result.isBillingError);
        setStatus('idle');
        return;
      }

      sessionIdRef.current = result.sessionId || null;
      setMaxDurationSeconds((result.maxDurationMinutes || 5) * 60);
      setIsActive(true);

      // 2. Play greeting
      const greeting = `Hello, I'm your AI book tutor for ${book.title}. How would you like to start? Ask me any questions about the book!`;
      
      setStatus('speaking');
      setCurrentMessage(greeting);

      speakResponse(greeting, () => {
        setMessages([{ role: 'assistant', content: greeting }]);
        setCurrentMessage('');
        
        if (isActiveRef.current) {
          setStatus('listening');
          startListening();
        }
      });

    } catch (err) {
      console.error('Failed to start tutoring session:', err);
      toast.error('Failed to initialize session. Please try again.');
      setStatus('idle');
    }
  };

  // Stop the voice tutor session
  const stopSession = useCallback(async (errorMsg?: string) => {
    setIsActive(false);
    setStatus('idle');

    // Clean up recognition
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.stop();
      } catch (e) {}
      recognitionRef.current = null;
    }

    // Cancel speech synthesis
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    // Log end session duration in MongoDB
    if (sessionIdRef.current) {
      try {
        await endVoiceSession(sessionIdRef.current, durationRef.current);
      } catch (err) {
        console.error('Failed to log voice session termination:', err);
      }
      sessionIdRef.current = null;
    }

    setCurrentMessage('');
    setCurrentUserMessage('');

    if (errorMsg) {
      toast.warning(errorMsg);
    }
  }, []);

  // Timer effect
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (isActive) {
      timer = setInterval(() => {
        setDuration(prev => {
          if (prev >= maxDurationSeconds) {
            stopSession('Session duration limit reached.');
            return prev;
          }
          return prev + 1;
        });
      }, 1000);
    } else {
      setDuration(0);
    }

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isActive, maxDurationSeconds, stopSession]);

  // Clean up session if unmounting
  useEffect(() => {
    return () => {
      if (sessionIdRef.current) {
        // Sync-ish end voice session on unmount
        const sessId = sessionIdRef.current;
        const dur = durationRef.current;
        
        // Stop recognition/speech
        if (recognitionRef.current) {
          try { recognitionRef.current.stop(); } catch (e) {}
        }
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }

        // Send beacon or fetch to end session quickly
        navigator.sendBeacon = navigator.sendBeacon || (() => false);
        endVoiceSession(sessId, dur).catch(err => console.error(err));
      }
    };
  }, []);

  // Text input submit handler
  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    
    const query = textInput;
    setTextInput('');

    if (!isActive) {
      // If session isn't running, start it
      toast.info('Starting tutor session...');
      startSession().then(() => {
        submitQuestion(query);
      });
    } else {
      submitQuestion(query);
    }
  };

  const getStatusDisplay = () => {
    switch (status) {
      case 'connecting': return { label: 'Connecting...', color: 'vapi-status-dot-connecting' };
      case 'listening': return { label: 'Listening', color: 'vapi-status-dot-listening' };
      case 'thinking': return { label: 'Thinking...', color: 'vapi-status-dot-thinking' };
      case 'speaking': return { label: 'Speaking', color: 'vapi-status-dot-speaking' };
      default: return { label: 'Ready', color: 'vapi-status-dot-ready' };
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-8">
      {/* Header Card */}
      <div className="vapi-header-card shadow-sm border border-[rgba(33,42,59,0.08)] bg-[#f3e4c7] transition-all">
        <div className="vapi-cover-wrapper relative">
          <Image
            src={book.coverURL || '/images/book-placeholder.png'}
            alt={book.title}
            width={120}
            height={180}
            className="vapi-cover-image rounded-lg object-cover !w-[120px] !h-auto border border-[rgba(33,42,59,0.15)] shadow-md"
            priority
          />
          <div className="vapi-mic-wrapper absolute -bottom-2 -right-2 relative z-20">
            {isActive && (status === 'speaking' || status === 'thinking' || status === 'listening') && (
              <div className="vapi-pulse-ring absolute inset-0 rounded-full bg-white animate-ping opacity-75" />
            )}
            <button
              onClick={isActive ? () => stopSession() : startSession}
              disabled={status === 'connecting'}
              aria-label={isActive ? 'Stop listening' : 'Start talking'}
              className={`vapi-mic-btn shadow-md hover:shadow-lg !w-[60px] !h-[60px] z-10 flex items-center justify-center transition-all ${
                isActive ? 'vapi-mic-btn-active bg-[#212a3b] text-white hover:bg-[#3d485e]' : 'vapi-mic-btn-inactive bg-white text-[#212a3b] hover:bg-gray-50'
              }`}
            >
              {isActive ? (
                <Mic className="size-7 text-white animate-pulse" />
              ) : (
                <MicOff className="size-7 text-[#212a3b]" />
              )}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-4 flex-1">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold font-serif text-[#212a3b] mb-1 leading-tight">
              {book.title}
            </h1>
            <p className="text-[#3d485e] font-medium text-sm sm:text-base">by {book.author}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="vapi-status-indicator flex items-center gap-2 bg-white px-3 py-1.5 rounded-md border border-[rgba(33,42,59,0.06)] shadow-sm">
              <span className={`vapi-status-dot w-2.5 h-2.5 rounded-full ${statusDisplay.color}`} />
              <span className="vapi-status-text font-serif text-xs font-semibold text-[#212a3b]">{statusDisplay.label}</span>
            </div>

            <div className="vapi-status-indicator flex items-center gap-2 bg-white px-3 py-1.5 rounded-md border border-[rgba(33,42,59,0.06)] shadow-sm">
              <span className="vapi-status-text font-serif text-xs font-semibold text-[#212a3b]">Voice: {book.persona || 'Rachel'}</span>
            </div>

            <div className="vapi-status-indicator flex items-center gap-2 bg-white px-3 py-1.5 rounded-md border border-[rgba(33,42,59,0.06)] shadow-sm">
              <span className="vapi-status-text font-serif text-xs font-semibold text-[#212a3b]">
                {formatDuration(duration)} / {formatDuration(maxDurationSeconds)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Transcript Card */}
      <div className="vapi-transcript-wrapper rounded-[14px] overflow-hidden border border-[rgba(33,42,59,0.1)] shadow-md flex flex-col bg-white">
        <div className="transcript-container flex-1 min-h-[350px] max-h-[500px] flex flex-col">
          <Transcript
            messages={messages}
            currentMessage={currentMessage}
            currentUserMessage={currentUserMessage}
          />
        </div>

        {/* Text Input Footer */}
        <form onSubmit={handleTextSubmit} className="p-4 bg-[var(--bg-primary)] border-t border-[rgba(33,42,59,0.1)] flex items-center gap-3">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={isActive ? "Type a question..." : "Type a question to start tutor session..."}
            className="flex-1 px-4 py-3 rounded-lg border border-[rgba(33,42,59,0.15)] bg-white text-[#212a3b] placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#212a3b] text-base"
          />
          <button
            type="submit"
            className="h-12 w-12 rounded-lg bg-[#212a3b] hover:bg-[#3d485e] text-white flex items-center justify-center transition-colors cursor-pointer shadow-sm disabled:opacity-50"
            disabled={status === 'thinking' || status === 'connecting'}
            aria-label="Send message"
          >
            {status === 'thinking' ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

export default VoiceAssistant;
