import { Schema } from "effect"

/** The caller sent something that cannot be acted on. Message is safe to show. */
export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 }
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

/** Signed in or not, this is not allowed. Message is safe to show. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 }
) {}

/** Postgres rejected or failed a statement. Carries what Postgres said. */
export class QueryError extends Schema.TaggedError<QueryError>()(
  "QueryError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
    hint: Schema.optional(Schema.String),
    position: Schema.optional(Schema.Int)
  },
  { httpApiStatus: 422 }
) {}

/** Too many failed sign-in attempts; try again later. */
export class TooManyAttempts extends Schema.TaggedError<TooManyAttempts>()(
  "TooManyAttempts",
  { message: Schema.String },
  { httpApiStatus: 429 }
) {}
