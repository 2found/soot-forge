# Nest no code pack

Owner chat and Nest's **Settings → Live chat** edit the same gateway records. The pack provides a generic tool interface; it does not add a runtime endpoint, own identity/credentials or start ingress.

Install dependencies with `pnpm install --frozen-lockfile`. Explicitly grant `nest-no-code/configure` to an owner configurator Soot, and bind `NO_CODE_URL` (the complete `/admin/control` endpoint URL) plus that owner's `NO_CODE_TOKEN` to its view/action operations. Use the existing host credential/`operation_env` configuration described in [pack authoring](../../CONTRIBUTING.md). The credential's tenant, actor and role are selected by the gateway host, never tool input.

Deploy the [Live chat adapter](https://github.com/2found/2agent/tree/main/contrib/adapters/live-chat) and a trusted-backend runtime binding. In Nest select the configurator, create a website, enter its HTTPS origins, save and publish, then copy the embed snippet. From chat ask that same configurator: “Đổi tên Live chat thành Mây Store và phát hành.” The skill reads the latest revision and uses CAS; Nest preserves a dirty draft if the chat changes configuration concurrently.

Google Sheets is optional. Install [its pack](../live-chat-sheets/README.md), grant an owner capability, add the host binding, connect Google or share the file with the service account, enter an empty dedicated tab, save, check and publish. Website guests never receive owner or Google credentials.

Owner tools use the bundled `sdk/` public wire codec; there is no private npm or sibling dependency. Installing never grants owner access or starts the gateway/export worker.
