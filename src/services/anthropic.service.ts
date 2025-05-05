import { anthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';

interface AnthropicResponse {
  response: string;
  tokensUsed: number;
}

interface ChatMessage {
  message: string;
  response: string;
}

interface TextDeltaChunk {
  type: 'text-delta';
  textDelta: string;
}

interface ToolCallStartChunk {
  type: 'tool-call-streaming-start';
  toolCallId: string;
  toolName: string;
}

interface ToolCallDeltaChunk {
  type: 'tool-call-delta';
  toolCallId: string;
  toolName: string;
  argsTextDelta: string;
}

type StreamChunk = TextDeltaChunk | ToolCallStartChunk | ToolCallDeltaChunk;

@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);
  
  private readonly models = {
    opus: 'claude-3-opus-latest',
    sonnet: 'claude-3-5-sonnet-latest',
    haiku: 'claude-3-5-haiku-latest'
  };

  private readonly tokenLimits = {
    opus: 10000,
    sonnet: 8000,
    haiku: 3000
  };

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService
  ) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    process.env.ANTHROPIC_API_KEY = apiKey;
  }

  async generateResponse(prompt: string, model = 'sonnet'): Promise<AnthropicResponse> {
    if (!prompt) throw new Error('Invalid prompt: must be a non-empty string');

    try {
      this.logger.log(`Generating response with model: ${model}`);
      // this.logger.debug(`Prompt: ${prompt}`);

      const modelName = this.models[model.toLowerCase()] || this.models.sonnet;
      const maxTokens = this.tokenLimits[model.toLowerCase()] || this.tokenLimits.sonnet;

      const { text, usage } = await generateText({
        model: anthropic(modelName),
        prompt,
        temperature: 0.7,
        maxTokens,
      });

      this.logger.log(`Response received - Length: ${text.length} chars`);
      // this.logger.debug(`Full response: ${text}`);
      this.logger.log(`Tokens used: ${usage?.totalTokens || Math.ceil(text.length / 4)}`);

      return {
        response: text,
        tokensUsed: usage?.totalTokens || Math.ceil(text.length / 4)
      };
    } catch (error) {
      this.logger.error(`Error generating response: ${error.message}`);
      this.logger.error(error.stack);
      throw error;
    }
  }

  async generateStreamingResponse(prompt: string, model = 'sonnet', userId = 0, threadId?: string) {
    if (!prompt) throw new Error('Invalid prompt: must be a non-empty string');

    try {
      this.logger.log(`Generating streaming response with model: ${model}`);
      // this.logger.debug(`Prompt: ${prompt}`);

      const modelName = this.models[model.toLowerCase()] || this.models.sonnet;
      const maxTokens = this.tokenLimits[model.toLowerCase()] || this.tokenLimits.sonnet;

      const result = streamText({
        model: anthropic(modelName),
        prompt,
        temperature: 0.7,
        maxTokens,
        onFinish: async (event) => {  // Changed to arrow function to preserve 'this' context
          const tokensUsed = event.usage.totalTokens || Math.ceil(event.text.length / 4);
          const responseText = event.text || ""; 

          if (userId && threadId) {
            try {
              // Extract the original user message from the prompt
              const userMessageMatch = prompt.match(/User: (.*?)\n\nAssistant:/);
              const userMessage = userMessageMatch ? userMessageMatch[1] : "Unknown message";

              // Save to database
              const chat = await this.prisma.chat.create({
                data: {
                  message: userMessage,
                  response: responseText,
                  tokensUsed,
                  userId,
                  threadId,
                  service: 'anthropic',
                  model: model || 'sonnet'
                }
              });
              
              // Deduct token units
              await this.prisma.user.update({
                where: { id: userId },
                data: {
                  tokenUnits: { decrement: tokensUsed }
                }
              });
              
              // Record token usage
              await this.prisma.tokenUsage.create({
                data: {
                  userId,
                  model: modelName,
                  tokensUsed
                }
              });

              this.logger.log(`Chat response saved to database for threadId: ${threadId}`);
            } catch (error) {
              this.logger.error(`Error saving chat response: ${error.message}`);
            }
          }
        },
      });
      // Return the result object directly for more flexible handling
      return result;
    } catch (error) {
      this.logger.error(`Error generating streaming response: ${error.message}`);
      throw error;
    }
  }

  async generateStructuredResponse(
    systemPrompt: string,
    userPrompt: string,
    previousMessages: ChatMessage[] = [],
    model = 'sonnet'
  ): Promise<AnthropicResponse> {
    let prompt = `${systemPrompt}\n\n`;
    
    previousMessages.forEach(msg => {
      prompt += `User: ${msg.message}\nAssistant: ${msg.response}\n\n`;
    });
    
    prompt += `User: ${userPrompt}\n\nAssistant:`;
    
    return this.generateResponse(prompt, model);
  }
}