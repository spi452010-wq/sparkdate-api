import { baseRepository } from '../../utils/repository';
import { Otp } from './otp.model';
import { RefreshToken } from './refreshToken.model';

export const otpRepository = baseRepository(Otp);
export const refreshTokenRepository = baseRepository(RefreshToken);
