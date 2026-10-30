import { z } from 'zod';
import { isValidKey } from '../../integrations/storage';

const age = (dob: Date) => { const n = new Date(); let a = n.getFullYear() - dob.getFullYear(); const m = n.getMonth() - dob.getMonth(); if (m < 0 || (m === 0 && n.getDate() < dob.getDate())) a--; return a; };
export const mediaKey = z.string().refine(isValidKey, 'Invalid media key');
const base = {
  fullName: z.string().trim().min(2).max(50),
  gender: z.enum(['male', 'female']),
  interestedIn: z.enum(['male', 'female']),
  dob: z.coerce.date().refine((d) => age(d) >= 18 && age(d) <= 100, 'Must be 18 or older'),
  bio: z.string().trim().max(300).optional(),
  city: z.string().trim().max(60).optional(),
  interests: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  photos: z.array(mediaKey).min(1).max(6),
};
export const completeSchema = z.object(base).strict();
// Gender and DOB are locked after completion (matching depends on them); admin can fix.
export const updateSchema = z.object({ fullName: base.fullName, interestedIn: base.interestedIn, bio: base.bio, city: base.city, interests: base.interests, photos: base.photos }).partial().strict();
export const verificationSchema = z.object({ selfieKey: mediaKey }).strict();
