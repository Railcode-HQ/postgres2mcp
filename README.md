# postgres2mcp

`postgres2mcp` takes a Postgres connection and gives you a fully-featured MCP server with governance built-in.

Create custom tools from parametrized SQL and determine what tools are accessible or blocked for each generated API key.

![postgres2mcp dashboard](docs/images/overview.png)

> This README is written by a human and is meant for humans. The docs are written by an agent and made for agents.

## 🚀 Get started


```sh
curl -fsSL https://raw.githubusercontent.com/Railcode-HQ/postgres2mcp/main/install.sh | bash
```

or tell your coding agent:

```
Read https://raw.githubusercontent.com/Railcode-HQ/postgres2mcp/main/install.sh and help me install and run postgres2mcp on this machine
```

## Features

* Built-in tools for common use cases
* Create custom tools from parametrized SQL
* Scoped API keys
* Group tools and control permissions by group
* Complete audit logs and analytics
* Choose your response format
* Self-host in under 10min
* MIT-licensed

## Benefits

* Quickly create an MCP server from your Postgres databases
* Have an easy way to manage and oversee database access
* Custom tools work as a semantic layer for agents to navigate your data more efficiently
* Enforce data governance by controlling the specific queries that are available to non-technical users

## Why

We built `postgres2mcp` to make it easy to give agents access to Postgres databases while ensuring orgs retain control and can manage permissions more easily than they would be able to with roles in Postgres.

`postgres2mcp` primarily targets two use cases:

- Managing MCP access to production data across employees
- Easily controlling what data is made accessible to third-party platforms that connect to your DB

At [Railcode](https://railcode.dev) we're a third-party that customers often connect their database to, so part of our motivation here was to offer customers a simple auditable platform where they can manage what data they give us access to. `postgres2mcp` borrowed a lot of concepts that we already use internally in the Railcode platform, but extracts them into code that users can verify and manage themselves. More about using `postgres2mcp` with Railcode in its dedicated section.


## How it works

1. Spin up a self-hosted instance of `postgres2mcp` (~10min)
2. Connect your Postgres database (see Security for more details)
3. An MCP server will immediately be available and various tools for inspecting and querying the database come out of the box
4. Create your own tools with parametrized SQL (from the UI or via MCP)

e.g. Create a `fetch_users_by_org` tool, defined as follows:

```sql
SELECT name, email, date_joined, organization_id
FROM users
WHERE organization_id = :organization_id
```

An MCP client can then call it with `fetch_users_by_org(123)`. You can also set a description and usage instructions for agents.

5. Create API keys that specify what tools can be used

e.g. API key `john-doe-from-growth` gets access to `referral_sources`, `mrr_by_customer`, and `organization_details`, but does not get access to run arbitrary SQL or create new tools

6. Users connect to the MCP from their agent using the API key provided to them with access to the tools the key has access to

7. Monitor usage logs and analytics from the dashboard


## Security

`postgres2mcp` is a gate to your database, so you should take the appropriate measures to ensure it's secure.

If it's used a layer in front of a third-party service, we recommend deploying it inside a private subnet and restricting inbound access to the third party’s egress IP addresses.

If used for giving employees access to production data, consider only making it available via your VPN or inside your Tailnet.

Also make sure you:

* Follow the principle of least privilege and set up an appropriate role that `postgres2mcp` has access to.
* Set a strong admin password. We intend to add support for 2FA for admins soon.

Lastly, note that this repo has been kept intentionally small so it should be very easy for a human or coding agent to audit its security.

## Using with [Railcode](https://railcode.dev)

`postgres2mcp` can be used with Railcode by adding it as a "Custom MCP" connector in Railcode.

Railcode provides you with all the granular permissions management features that `postgres2mcp` offers, but if you're more comfortable managing them from `postgres2mcp`, you can create multiple API keys and set up various MCP connectors in Railcode, each tied to a `postgres2mcp` key with different permissions.


## License

MIT