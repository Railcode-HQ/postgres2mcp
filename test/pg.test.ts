import { describe, expect, test } from "bun:test"
import { connectionConfig } from "../src/services/Pg.ts"

const base = "postgres://app:secret@db.example.com:5432/shop"

describe("connectionConfig", () => {
  test("sslmode=require encrypts without demanding a CA bundle", () => {
    expect(connectionConfig(`${base}?sslmode=require`).ssl).toEqual({ rejectUnauthorized: false })
  })

  test("sslmode=verify-full verifies against the runtime's CA list", () => {
    expect(connectionConfig(`${base}?sslmode=verify-full`).ssl).toEqual({})
  })

  test("sslrootcert=system means verify-full, and the rest of the URL is kept", () => {
    const config = connectionConfig(`${base}?sslmode=verify-full&sslrootcert=system&application_name=p2m`)
    expect(config.ssl).toEqual({})
    expect(config).toMatchObject({
      host: "db.example.com",
      port: 5432,
      database: "shop",
      user: "app",
      password: "secret",
      application_name: "p2m"
    })
  })

  test("sslrootcert=system wins over a weaker sslmode, or none", () => {
    expect(connectionConfig(`${base}?sslmode=require&sslrootcert=system`).ssl).toEqual({})
    expect(connectionConfig(`${base}?sslrootcert=system`).ssl).toEqual({})
  })
})
