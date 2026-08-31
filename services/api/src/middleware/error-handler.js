/** One error shape for the whole API. Never leaks a stack trace or a secret. */
export function errorHandler(err, req, res, _next) {
  const status = err.status || (err.code === "23505" || err.code === "duplicate_value" ? 409 : 500);
  const code = err.code === "23505" ? "duplicate_value" : (err.code || "internal_error");
  req.log?.error({ err, request_id: req.id }, "request failed");
  res.status(status).json({
    code,
    message: status === 500 ? "Something went wrong on our side. The request id will let us find it." : err.message,
    request_id: req.id,
    ...(err.field ? { field: err.field } : {}),
    ...(err.fields ? { fields: err.fields } : {}),
  });
}
