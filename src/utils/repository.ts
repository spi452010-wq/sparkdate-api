import { Model } from 'mongoose';

/**
 * Standard data-access surface over one Mongoose model. Each module's <module>.repository.ts builds
 * its repositories from this and adds named domain queries; models are never imported outside
 * their own module's repository.
 */
export const baseRepository = <M extends Model<any>>(m: M) => ({
  find: m.find.bind(m) as M['find'],
  findOne: m.findOne.bind(m) as M['findOne'],
  findById: m.findById.bind(m) as M['findById'],
  create: m.create.bind(m) as M['create'],
  updateOne: m.updateOne.bind(m) as M['updateOne'],
  updateMany: m.updateMany.bind(m) as M['updateMany'],
  findOneAndUpdate: m.findOneAndUpdate.bind(m) as M['findOneAndUpdate'],
  findByIdAndUpdate: m.findByIdAndUpdate.bind(m) as M['findByIdAndUpdate'],
  findOneAndDelete: m.findOneAndDelete.bind(m) as M['findOneAndDelete'],
  deleteOne: m.deleteOne.bind(m) as M['deleteOne'],
  countDocuments: m.countDocuments.bind(m) as M['countDocuments'],
  exists: m.exists.bind(m) as M['exists'],
  distinct: m.distinct.bind(m) as M['distinct'],
});
