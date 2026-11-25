# Troubleshoot setup and Project access

A successful GitHub CLI login in an interactive terminal can hide a different identity in the orchestrator's environment. Run these checks in the same shell or launcher environment as the failing `grait init`, `grait activate`, or orchestrator command. See the [setup reference](../setup.md) and [installation guide](../installation.md) for the full workflow.

## Check the credentials and recorded binding

GRAIT uses a nonempty `PROJECT_TOKEN` for Project requests. Otherwise it uses `GH_TOKEN`, then asks `gh auth token` for the active GitHub CLI credential. This normally comes from the stored login. GitHub CLI can also pick up an inherited `GITHUB_TOKEN` when `GH_TOKEN` is unset. Repository requests that read the binding use the `GH_TOKEN` or GitHub CLI credential even when `PROJECT_TOKEN` is set.

Applying setup records three non-secret GitHub Actions repository variables under **Settings → Secrets and variables → Actions → Variables**. `PROJECT_OWNER` is the owner's login, `PROJECT_NUMBER` is the number from the Project URL, and `PROJECT_ID` is the GraphQL node ID. Setup records the resolved identity before proceeding with further configuration so it can reuse the same Project on a retry. The runtime reads the repository variables and loads the queue by `PROJECT_ID`.

Replace `OWNER/REPOSITORY` with the controller repository. The commands show account logins and Project metadata. Run them with shell tracing and GitHub CLI debug output off to keep credentials out of logs.

```sh
repo='OWNER/REPOSITORY'

repo_api() (
  repo_token=${GH_TOKEN:-}
  if [ -z "$repo_token" ]; then
    repo_token=$(gh auth token) || exit 1
    github_token=$(gh auth token --hostname github.com) || exit 1
    if [ -z "$repo_token" ] || [ "$repo_token" != "$github_token" ]; then
      printf '%s\n' 'Select the intended GitHub.com credential before retrying.' >&2
      exit 1
    fi
  fi
  GH_TOKEN="$repo_token" gh api --hostname github.com "$@"
)

project_api() {
  if [ -n "${PROJECT_TOKEN:-}" ]; then
    GH_TOKEN="$PROJECT_TOKEN" gh api --hostname github.com "$@"
  else
    repo_api "$@"
  fi
}

repo_api user --jq '"Repository login: " + .login'
project_api user --jq '"Project login: " + .login'

for name in PROJECT_ID PROJECT_OWNER PROJECT_NUMBER; do
  repo_api "repos/$repo/actions/variables/$name" --jq '.name + "=" + .value'
done
```

An inherited `GH_HOST` can make `gh auth token` select a credential for another host. With no explicit `GH_TOKEN`, the repository check and the Project fallback compare the credential GRAIT would select with the active GitHub.com credential before sending any request. If either lookup fails or the credentials differ, explicitly select the intended GitHub.com credential in the failing environment and rerun the checks.

A failure reading the repository variables points to the repository identity or permissions. Confirm the controller repository and repository login before using the values to diagnose the Project. If the Project login differs from what you intended, inspect which variables the launcher supplies. A stale `PROJECT_TOKEN` overrides both `GH_TOKEN` and the interactive login, and a stale `GH_TOKEN` overrides the stored login. Update the token selection in the launcher, restart it if needed to pick up the change, and rerun the login checks. If you intentionally switch to the stored login, confirm that it belongs to the intended account before retrying.

## Check access to the bound Project

Use the `project_api` function above and substitute the recorded `PROJECT_ID`. This read-only query looks up the same node as the runtime and reports the visible Project's ID, owner, number, and URL.

```sh
project_id='RECORDED_PROJECT_ID'
project_api graphql -f id="$project_id" -f query='
  query($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        id
        number
        url
        owner {
          ... on User { login }
          ... on Organization { login }
        }
      }
    }
  }' --jq .data.node
```

Compare the returned owner and number with `PROJECT_OWNER` and `PROJECT_NUMBER`. If the lookup fails or returns a null node, verify the binding and confirm access for the **Project login** printed above. A token can have the `project` scope while its account lacks access to this particular Project. A successful lookup demonstrates read access. GRAIT also needs Write access to move items.

For a user-owned Project, have the owner or a Project admin open the Project's **Settings → Manage access**. Under **Invite collaborators**, select the Project login and invite it with the **Write** role, or set its existing role to **Write**. Have that account accept the invitation if prompted. See [GitHub's Project access instructions](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/managing-access-to-your-projects#managing-access-for-user-level-projects).

Repeat the lookup with the same credential. On an activated host, rerun `grait orchestrator status` from the application checkout with the [pinned package](../installation.md#choose-and-run-a-pinned-cli). If setup is still pending, retry `grait init` with the original options or retry `grait activate` after human merge and CI. Use the same package pin and the GitHub identity you verified.

## Rebinding a Project intentionally

Resolve credential or collaborator access problems against the recorded Project. For an intentional move to another Project, have the operator pause the live installation first by setting `AUTOMATION_ENABLED=false` and stopping active agents and any remaining hosted runs. Setup rejects live reconfiguration and checks that a supplied owner or number agrees with the recording, that the resolved node ID matches `PROJECT_ID`, and that any controller marker on the target Project matches this repository. Reconcile the current board and recorded binding with the operator before attempting setup again. Follow the [installation recovery instructions](../installation.md#resume-remote-hosts-and-credentials).
