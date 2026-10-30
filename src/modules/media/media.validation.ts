// Uploads are multipart (validated by multer limits + sharp decode in the service); signed reads are checked by HMAC.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
