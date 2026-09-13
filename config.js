/*
 * Where the photo booth uploads each session's files.
 *
 * These are PLACEHOLDER DEFAULTS. Check them against the photobooth app's
 * upload settings before relying on this site (see "Defaults you must check"
 * in README.md).
 *
 * Images are requested from:
 *
 *   <base URL>/<event>/<uuid>/<file>
 *
 * where <base URL> is `baseUrlOverride` when it is set, and otherwise the S3
 * virtual-hosted URL built from the bucket and region:
 *
 *   https://<bucket>.s3.<region>.amazonaws.com
 *   (with the defaults: https://iangitscode-photobooth.s3.us-east-1.amazonaws.com)
 */
window.PHOTO_VIEWER_CONFIG = Object.freeze({
  // S3 bucket the booth uploads to. Objects must be publicly readable.
  bucket: 'iangitscode-photobooth',

  // AWS region that bucket lives in, e.g. 'us-east-1' or 'eu-west-2'.
  region: 'us-east-1',

  // Optional full base URL that replaces the bucket/region URL entirely, for
  // when the files are served through CloudFront or a custom domain, e.g.
  // 'https://d111111abcdef8.cloudfront.net'. A trailing slash is fine.
  // Leave as '' to load straight from S3.
  baseUrlOverride: '',
});
