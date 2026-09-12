import { Controller, Get } from '@nestjs/common';
import { SkipHttpRateLimit } from '../http-abuse/http-abuse.metadata';

@Controller('health')
@SkipHttpRateLimit()
export class HealthController {
  @Get()
  getHealth() {
    return {
      success: true,
      data: {
        status: 'ok',
        service: 'api',
        timestamp: new Date().toISOString(),
      },
    };
  }
}
