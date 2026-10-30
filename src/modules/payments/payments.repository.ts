import { baseRepository } from '../../utils/repository';
import { Payment } from './payment.model';

export const paymentRepository = baseRepository(Payment);
