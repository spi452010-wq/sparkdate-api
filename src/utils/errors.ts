export class AppError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) {
    super(message ?? code);
  }
}
export const asyncHandler =
  (fn: (req: any, res: any, next: any) => Promise<unknown>) => (req: any, res: any, next: any) =>
    fn(req, res, next).catch(next);
