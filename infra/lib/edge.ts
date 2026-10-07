/**
 * CloudFront Functions (cloudfront-js-2.0, viewer-request) and the response security headers.
 * The function bodies are plain ES5 so the tests can evaluate them in Node as-is.
 */

/** SPEC "Architecture": SPA routes (no file extension in the last segment) are served index.html. */
export const SPA_REWRITE_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var last = uri.substring(uri.lastIndexOf("/") + 1);
  if (last.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}`;

/**
 * /api/* and /s/*: the origin never sees the viewer Host (API Gateway needs its own), so pass it on
 * for building public URLs, plus the viewer IP for rate limiting. Client-sent values are overwritten.
 */
export const FORWARD_HOST_CODE = `function handler(event) {
  var request = event.request;
  var headers = request.headers;
  if (headers.host && headers.host.value) {
    headers["x-forwarded-host"] = { value: headers.host.value };
  } else {
    delete headers["x-forwarded-host"];
  }
  headers["x-viewer-ip"] = { value: event.viewer.ip };
  return request;
}`;

/**
 * /media/share/<id>.png is stored in the media bucket as share/<id>.png. Nothing else in the bucket
 * is public: a card hidden by moderation is moved to hidden/share/<id>.png, which must stay
 * unreachable, so every other path is a 404 here (before S3 is asked).
 */
export const MEDIA_PATH_CODE = `function handler(event) {
  var request = event.request;
  if (/^\\/media\\/share\\/[0-9A-Za-z_-]+\\.png$/.test(request.uri)) {
    request.uri = request.uri.substring("/media".length);
    return request;
  }
  return { statusCode: 404, statusDescription: "Not Found" };
}`;

/** SPEC "Architecture" — the SPA. */
export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** /s/:id is server-rendered HTML with no scripts at all. */
export const SHARE_PAGE_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** JSON responses never render anything. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** Features the app never uses. Web Share, notifications and file inputs are not gated by these. */
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()";

/** HSTS max-age: 2 years. */
export const HSTS_MAX_AGE_SECONDS = 63_072_000;
