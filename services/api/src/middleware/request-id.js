import { randomUUID } from "crypto";
/** Every request carries an id that appears in logs and in every error body. */
export function requestId(req, res, next) {
  req.id = req.headers["x-request-id"] || `req_${randomUUID()}`;
  res.setHeader("X-Request-Id", req.id);
  next();
}
