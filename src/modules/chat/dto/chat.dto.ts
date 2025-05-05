import { IsString, IsOptional, IsUUID } from 'class-validator';

export class ChatRequestDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsUUID()
  threadId?: string;
}

export class UpdateThreadTitleDto {
  @IsString()
  title: string;
}
