import { baseRepository } from '../../utils/repository';
import { Event } from './event.model';
import { EventReaction } from './reaction.model';
import { Gender } from '../users/users.types';

export const eventRepository = baseRepository(Event);
export const reactionRepository = baseRepository(EventReaction);

/** Atomic seat hold: never exceeds capacity, even under concurrency; only future published events. */
export const reserveSeat = (eventId: any, gender: Gender) =>
  Event.updateOne({ _id: eventId, status: 'published', startsAt: { $gt: new Date() }, $expr: { $lt: [`$booked.${gender}`, `$capacity.${gender}`] } }, { $inc: { [`booked.${gender}`]: 1 } })
    .then((r) => r.modifiedCount === 1);
export const releaseSeat = (eventId: any, gender: Gender) =>
  Event.updateOne({ _id: eventId, [`booked.${gender}`]: { $gt: 0 } }, { $inc: { [`booked.${gender}`]: -1 } });
