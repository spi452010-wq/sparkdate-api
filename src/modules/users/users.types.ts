import { UserDoc } from './user.model';

export type { UserDoc };
export type Role = 'user' | 'host' | 'admin';
export type Gender = 'male' | 'female';
export type VerificationStatus = 'none' | 'pending' | 'approved' | 'rejected';
export interface UserSummary { id: string; fullName: string | null; phone: string | null }
