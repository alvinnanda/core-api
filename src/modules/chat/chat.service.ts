// src/modules/chat/chat.service.ts
import { Injectable, Logger, ForbiddenException, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { PrismaService } from '../../prisma/prisma.service';
import { AnthropicService } from '../../services/anthropic.service';
import { EventEmitter } from 'events';
import { StreamTextResult } from 'ai';
import { Cache } from 'cache-manager';

interface ExtendedStreamTextResult extends StreamTextResult<Record<string, any>> {
  threadId?: string;
  tokensUsed?: number;
  stats?: {
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  usagePromise?: Promise<{
    status: any; 
    totalTokens?: number;
  }>;
  responsePromise?: Promise<{
    stats?: {
      totalTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
    };
  }>; // Add responsePromise property
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  private readonly MEMBERSHIP_UNITS = {
    FREE: 1000,
    BASIC: 900000,
    PREMIUM: 1800000
  };

  constructor(
    private prisma: PrismaService,
    private anthropic: AnthropicService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache
  ) {}

  private async checkAndUpdateTokenUnits(userId: number): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { 
        tokenUnits: true, 
        tokenResetDate: true, 
        membershipLevel: true 
      }
    });

    if (!user) throw new ForbiddenException('User not found');

    console.log('User token units:', user.tokenUnits);
    // Check if user has exceeded token units based on membership level
    if (user.tokenUnits <= 0) {
      throw new ForbiddenException('Token units exceed membership limit');
    }
    const now = new Date();
    const resetDate = user.tokenResetDate;

    // If resetDate is null or has passed, reset tokens
    if (!resetDate || resetDate < now) {
      const newResetDate = new Date();
      newResetDate.setMonth(newResetDate.getMonth() + 1);
      
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          tokenUnits: this.MEMBERSHIP_UNITS[user.membershipLevel],
          tokenResetDate: newResetDate
        }
      });
    }
  }

  private async deductTokenUnits(userId: number, tokensUsed: number): Promise<void> {
    const result = await this.prisma.user.updateMany({
      where: {
        id: userId,
        tokenUnits: { gte: tokensUsed }
      },
      data: {
        tokenUnits: { decrement: tokensUsed }
      }
    });
    if (result.count === 0) {
      this.logger.error(`Failed to deduct token units for userId: ${userId}`);
    }
  }

  async createChat(userId: number, message: string, threadId?: string, model?: string) {
    try {
      // Check and update token units if needed
      await this.checkAndUpdateTokenUnits(userId);

      // Create new thread if not provided
      if (!threadId) {
        const thread = await this.prisma.chatThread.create({
          data: {
            userId,
            title: message.substring(0, 255)// Use message start as initial title
          }
        });
        threadId = thread.id;
      }

      // Get previous messages
      const previousMessages = await this.prisma.chat.findMany({
        where: { threadId },
        orderBy: { createdAt: 'asc' },
        select: { message: true, response: true }
      });

      const systemPrompt = "Use claude default response";
      const { response, tokensUsed } = await this.anthropic.generateStructuredResponse(
        systemPrompt,
        message,
        previousMessages,
        model || 'sonnet'  // Pass model string directly instead of config object
      );

      // Deduct tokens before saving chat
      await this.deductTokenUnits(userId, tokensUsed);

      const chat = await this.prisma.chat.create({
        data: {
          message,
          response,
          tokensUsed,
          userId,
          threadId,
          service: 'anthropic',          // Add service info
          model: model || 'sonnet'       // Store simplified model name
        }
      });

      // Update thread metadata
      await this.prisma.chatThread.update({
        where: { id: threadId },
        data: { 
          updatedAt: new Date()
        }
      });

      // Record token usage with specific model
      await this.prisma.tokenUsage.create({
        data: {
          userId,
          model: model || 'claude-3-sonnet-20240229',
          tokensUsed
        }
      });

      // Invalidate cache for user threads
      await this.cacheManager.del(`user_threads_${userId}`);

      // Return formatted response
      return {
        id: chat.id,
        threadId,
        message,
        response,
        tokensUsed,
        service: chat.service,
        model: chat.model,
        createdAt: chat.createdAt,
        messageCount: previousMessages.length + 1
      };
    } catch (error) {
      this.logger.error(`Error creating chat: ${error.message}`, error.stack);
      throw error;
    }
  }

  async createStreamingChat(userId: number, message: string, threadId?: string, model?: string) {
    try {
      await this.checkAndUpdateTokenUnits(userId);

      // Create or get thread ID first
      if (!threadId) {
        const thread = await this.prisma.chatThread.create({
          data: {
            userId,
            title: message.substring(0, 255) + '...'
          }
        });
        threadId = thread.id;
      }

      // Get previous messages once
      const previousMessages = await this.prisma.chat.findMany({
        where: { threadId },
        orderBy: { createdAt: 'asc' },
        select: { message: true, response: true }
      });

      // Prepare prompt once
      const systemPrompt = "Use default claude response";
      let prompt = `${systemPrompt}\n\n`;
      
      // Build context from previous messages
      previousMessages.forEach(msg => {
        prompt += `User: ${msg.message}\nAssistant: ${msg.response}\n\n`;
      });
      prompt += `User: ${message}\n\nAssistant:`;

      const streamResult: ExtendedStreamTextResult = await this.anthropic.generateStreamingResponse(prompt, model, userId, threadId);
      streamResult.threadId = threadId;  // Add threadId to result


      // // Create a new chat record first with empty response
      // const chat = await this.prisma.chat.create({
      //   data: {
      //     message,
      //     response: '', // Will be updated after stream completes
      //     tokensUsed: 0, // Will be updated after stream completes
      //     userId,
      //     threadId,
      //     service: 'anthropic',
      //     model: model || 'sonnet'
      //   }
      // });

      // Update thread metadata
      await this.prisma.chatThread.update({
        where: { id: threadId },
        data: { updatedAt: new Date() }
      });

      return streamResult;
    } catch (error) {
      this.logger.error('Error in createStreamingChat:', error);
      throw error;
    }
  }

  private async validateThreadAccess(threadId: string, userId: number): Promise<void> {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: { userId: true }
    });

    if (!thread || thread.userId !== userId) {
      throw new ForbiddenException('Access to this chat thread is forbidden');
    }
  }

  async getChatThread(threadId: string, userId: number) {
    await this.validateThreadAccess(threadId, userId);
    
    return this.prisma.chat.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' }
    });
  }

  async getUserThreads(userId: number) {
    const cacheKey = `user_threads_${userId}`;
    const cachedThreads = await this.cacheManager.get(cacheKey);

    if (cachedThreads) {
      return cachedThreads;
    }

    const threads = await this.prisma.chatThread.findMany({
      where: { userId },
      include: {
        chats: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            message: true,
            response: true,
            createdAt: true,
          }
        },
        _count: {
          select: { chats: true }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    await this.cacheManager.set(cacheKey, threads, 3600); // Cache for 1 hour
    return threads;
  }

  async getUserUsage(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { 
        tokenUnits: true, 
        membershipLevel: true,
        tokenResetDate: true
      }
    });

    return {
      remainingUnits: user.tokenUnits,
      totalUnits: this.MEMBERSHIP_UNITS[user.membershipLevel],
      resetDate: user.tokenResetDate,
      membershipLevel: user.membershipLevel
    };
  }

  async updateThreadTitle(threadId: string, title: string, userId: number) {
    await this.validateThreadAccess(threadId, userId);

    return this.prisma.chatThread.update({
      where: { id: threadId },
      data: { title }
    });
  }
}