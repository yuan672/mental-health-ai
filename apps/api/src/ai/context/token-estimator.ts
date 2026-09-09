import { Injectable } from '@nestjs/common';

export interface TokenEstimator {
  estimate(text: string): number;
}

@Injectable()
export class ConservativeTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    return Math.ceil(Buffer.byteLength(text, 'utf8') / 2) + 4;
  }
}
