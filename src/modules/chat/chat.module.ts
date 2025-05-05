// src/modules/chat/chat.module.ts
import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ChatController } from './chat.controller';
import { ChatService } from '../chat/chat.service';
import { AnthropicService } from '../../services/anthropic.service';

@Module({
  imports: [
    CacheModule.register(), // Register CacheModule
  ],
  controllers: [ChatController],
  providers: [ChatService, AnthropicService],
})
export class ChatModule {}