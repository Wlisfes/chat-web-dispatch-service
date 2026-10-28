import { Module } from '@nestjs/common'
import { ChargeClientService } from '@/modules/charge/charge.client'

@Module({ providers: [ChargeClientService], exports: [ChargeClientService] })
export class ChargeModule {}
