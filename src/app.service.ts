import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import * as HealthDto from '@/health/dto/health.dto'
import { HealthService } from '@/health/health.service'

@Injectable()
export class AppService {
    constructor(private readonly healthService: HealthService) {}

    /**调度服务信息。*/
    public async httpBaseDispatchResolverService(): Promise<string> {
        return 'Chat Web Dispatch Service'
    }

    /**调度服务存活状态。*/
    public async httpBaseDispatchLiveHealth(): Promise<HealthDto.ServiceLivenessResponseDto> {
        return this.healthService.getLiveness()
    }

    /**调度服务就绪状态。*/
    public async httpBaseDispatchReadyHealth(): Promise<HealthDto.ServiceReadinessResponseDto> {
        const result = await this.healthService.getReadiness()
        if (result.status !== 'UP') {
            throw new ServiceUnavailableException({ message: '调度服务尚未就绪', data: result })
        }
        return result
    }
}
