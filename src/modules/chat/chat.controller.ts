// src/modules/chat/chat.controller.ts
import { Controller, Post, Body, UseGuards, Get, Param, Put, Res, Header } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsageGuard } from '../../guards/usage.guard';
import { ChatService } from '../chat/chat.service';
import { GetUser } from '../../modules/auth/decorators/get-user.decorator';
import { UpdateThreadTitleDto } from './dto/chat.dto';
import { IsString, IsOptional, IsUUID, IsIn } from 'class-validator';

export class ChatRequestDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsUUID()
  threadId?: string;

  @IsString()
  @IsOptional()
  @IsIn(['opus', 'sonnet', 'haiku']) // Add validation for allowed models
  model?: string;

  @IsOptional()
  @IsString()
  provider?: string; // Tambahkan field provider
}

@Controller('chat')
@UseGuards(JwtAuthGuard, UsageGuard)
export class ChatController {
  constructor(private chatService: ChatService) {}

  @Post()
  async createChat(
    @GetUser('id') userId: number,
    @Body() chatRequest: ChatRequestDto
  ) {
    return this.chatService.createChat(
      userId, 
      chatRequest.message, 
      chatRequest.threadId
    );
  }

  @Post('stream')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  async createStreamingChat(
    @GetUser('id') userId: number,
    @Body() chatRequest: ChatRequestDto,
    @Res() response: any
  ) {
    try {
      const frontendUrl = process.env.FRONTEND_URL || 'http://192.168.1.19:3000';
      response.raw.setHeader('Access-Control-Allow-Origin', frontendUrl);
      response.raw.setHeader('Access-Control-Allow-Credentials', 'true');
      
      const result = await this.chatService.createStreamingChat(
        userId, 
        chatRequest.message, 
        chatRequest.threadId,
        chatRequest.model
      );

      // Send initial metadata with threadId
      // const metaData = JSON.stringify({
      //   type: 'meta',
      //   threadId: result.threadId,
      //   service: 'anthropic',
      //   model: chatRequest.model || 'sonnet'
      // });
      // response.raw.write(`data: ${metaData}\n\n`);

      // Use AI SDK's built-in streaming
      await result.pipeTextStreamToResponse(response.raw);

      // After stream ends, get usage stats
      const usage = await result.usage;
      
      // Send final stats
      const completeData = JSON.stringify({
        type: 'complete',
        threadId: result.threadId,
        service: 'anthropic',
        model: chatRequest.model || 'sonnet',
        stats: {
          totalTokens: usage?.totalTokens,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens
        }
      });
      
      response.raw.write(`data: ${completeData}\n\n`);
      response.raw.write('data: [DONE]\n\n');
      response.raw.end();

    } catch (error) {
      console.error('Controller error:', error);
      response.raw.write(`data: ${JSON.stringify({ 
        type: 'error', 
        error: error.message 
      })}\n\n`);
      response.raw.write('data: [DONE]\n\n');
      response.raw.end();
    }
  }

  @Put('thread/:threadId/title')
  async updateThreadTitle(
    @Param('threadId') threadId: string,
    @Body() dto: UpdateThreadTitleDto,
    @GetUser('id') userId: number
  ) {
    return this.chatService.updateThreadTitle(threadId, dto.title, userId);
  }

  @Get('threads')
  async getThreads(@GetUser('id') userId: number) {
    return this.chatService.getUserThreads(userId);
  }

  @Get('thread/:threadId')
  async getChatThread(
    @Param('threadId') threadId: string,
    @GetUser('id') userId: number
  ) {
    return this.chatService.getChatThread(threadId, userId);
  }

  @Get('usage')
  async getUsage(@GetUser('id') userId: number) {
    return this.chatService.getUserUsage(userId);
  }
}