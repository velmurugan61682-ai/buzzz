/** One error shape for the whole API. Never leaks a stack trace or a secret. */
export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  req.log?.error({ err, request_id: req.id }, "request failed");
  res.status(status).json({
    code: err.code || "internal_error",
    message: status === 500 ? "Something went wrong on our side. The request id will let us find it." : err.message,
    request_id: req.id,
    ...(err.fields ? { fields: err.fields } : {}),
  });
}
