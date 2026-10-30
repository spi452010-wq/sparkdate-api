import { baseRepository } from '../../utils/repository';
import { User } from './user.model';

export const userRepository = baseRepository(User);

