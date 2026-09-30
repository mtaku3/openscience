import { Select } from "@synsci/ui/select"
import { Icon, type IconProps } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { Component, For, createMemo, createSignal, type JSX } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import type { Config } from "@synsci/sdk/v2/client"
import { Section } from "./settings/_shared"
import { commitPermissionDefault, permissionActionFor, type PermissionAction } from "./settings/permission-defaults"
import { useProviders } from "@/hooks/use-providers"

const ACTIONS = [
  { value: "allow", label: "settings.permissions.action.allow" },
  { value: "ask", label: "settings.permissions.action.ask" },
  { value: "deny", label: "settings.permissions.action.deny" },
] as const

const ITEMS = [
  {
    id: "read",
    icon: "file",
    title: "settings.permissions.tool.read.title",
    description: "settings.permissions.tool.read.description",
  },
  {
    id: "edit",
    icon: "edit",
    title: "settings.permissions.tool.edit.title",
    description: "settings.permissions.tool.edit.description",
  },
  {
    id: "glob",
    icon: "folder-tree",
    title: "settings.permissions.tool.glob.title",
    description: "settings.permissions.tool.glob.description",
  },
  {
    id: "grep",
    icon: "magnifying-glass",
    title: "settings.permissions.tool.grep.title",
    description: "settings.permissions.tool.grep.description",
  },
  {
    id: "list",
    icon: "bullet-list",
    title: "settings.permissions.tool.list.title",
    description: "settings.permissions.tool.list.description",
  },
  {
    id: "bash",
    icon: "console",
    title: "settings.permissions.tool.bash.title",
    description: "settings.permissions.tool.bash.description",
  },
  {
    id: "task",
    icon: "task",
    title: "settings.permissions.tool.task.title",
    description: "settings.permissions.tool.task.description",
  },
  {
    id: "skill",
    icon: "flask",
    title: "settings.permissions.tool.skill.title",
    description: "settings.permissions.tool.skill.description",
  },
  {
    id: "lsp",
    icon: "code",
    title: "settings.permissions.tool.lsp.title",
    description: "settings.permissions.tool.lsp.description",
  },
  {
    id: "todoread",
    icon: "checklist",
    title: "settings.permissions.tool.todoread.title",
    description: "settings.permissions.tool.todoread.description",
  },
  {
    id: "todowrite",
    icon: "checklist",
    title: "settings.permissions.tool.todowrite.title",
    description: "settings.permissions.tool.todowrite.description",
  },
  {
    id: "planwrite",
    icon: "branch",
    title: "settings.permissions.tool.planwrite.title",
    description: "settings.permissions.tool.planwrite.description",
  },
  {
    id: "webfetch",
    icon: "link",
    title: "settings.permissions.tool.webfetch.title",
    description: "settings.permissions.tool.webfetch.description",
  },
  {
    id: "websearch",
    icon: "magnifying-glass",
    title: "settings.permissions.tool.websearch.title",
    description: "settings.permissions.tool.websearch.description",
  },
  {
    id: "codesearch",
    icon: "code-lines",
    title: "settings.permissions.tool.codesearch.title",
    description: "settings.permissions.tool.codesearch.description",
  },
  {
    id: "external_directory",
    icon: "folder",
    title: "settings.permissions.tool.external_directory.title",
    description: "settings.permissions.tool.external_directory.description",
  },
  {
    id: "doom_loop",
    icon: "alert-circle",
    title: "settings.permissions.tool.doom_loop.title",
    description: "settings.permissions.tool.doom_loop.description",
  },
] as const

// Tool allow/ask/deny defaults, rendered without page chrome so it can be
// composed as a section inside the unified Permissions panel.
export const PermissionToolDefaults: Component = () => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  const actions = createMemo((): Array<{ value: PermissionAction; label: string }> =>
    ACTIONS.map((action) => ({
      value: action.value,
      label: language.t(action.label),
    })),
  )

  const setPermission = async (id: string, action: PermissionAction) => {
    const result = await commitPermissionDefault(id, action, {
      isBusy: busy,
      permission: () => globalSync.data.config.permission,
      setPermission: (permission) => globalSync.set("config", "permission", permission as Config["permission"]),
      setBusy,
      write: (permission) => globalSync.updateConfig({ permission }),
    })
    if (!result.ok && "error" in result) {
      showToast({ title: language.t("settings.permissions.toast.updateFailed.title"), description: result.error })
    }
  }

  return (
    <Section
      title={language.t("settings.permissions.section.tools")}
      description="Set the default response for each class of tool request."
    >
      <div class="settings-card">
        <For each={ITEMS}>
          {(item) => (
            <SettingsRow icon={item.icon} title={language.t(item.title)} description={language.t(item.description)}>
              <Select
                aria-label={`${language.t(item.title)} permission`}
                options={actions()}
                current={actions().find(
                  (o) => o.value === permissionActionFor(globalSync.data.config.permission, item.id),
                )}
                value={(o) => o.value}
                label={(o) => o.label}
                disabled={busy()}
                onSelect={(option) => option && setPermission(item.id, option.value)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>
          )}
        </For>
      </div>
    </Section>
  )
}

type AutoApproveConfig = NonNullable<Config["auto_approve"]>

type JudgeOption = { value: string; label: string }

// Judges for the Auto access mode. Written to the global config only: the
// runtime reads auto_approve from trusted config, never from a project.
export const AutoApproveJudges: Component = () => {
  const globalSync = useGlobalSync()
  const providers = useProviders()
  const [busy, setBusy] = createSignal(false)

  const current = createMemo((): AutoApproveConfig => globalSync.data.config.auto_approve ?? {})
  const options = createMemo((): JudgeOption[] => [
    { value: "", label: "Default" },
    ...providers
      .connected()
      .flatMap((provider) =>
        Object.entries(provider.models).map(([id, model]) => ({
          value: `${provider.id}/${id}`,
          label: `${provider.name} · ${model.name ?? id}`,
        })),
      )
      .sort((a, b) => a.label.localeCompare(b.label)),
  ])
  const selected = (value: string | undefined) =>
    options().find((option) => option.value === (value ?? "")) ?? { value: value ?? "", label: value || "Default" }

  const setJudge = async (key: "judge" | "judge2", value: string) => {
    if (busy()) return
    const next: AutoApproveConfig = { ...current() }
    if (value) next[key] = value
    else delete next[key]
    setBusy(true)
    try {
      await globalSync.updateConfig({ auto_approve: next })
    } catch (error) {
      showToast({ title: "Could not update the reviewer", description: String(error) })
    } finally {
      setBusy(false)
    }
  }

  const rows = [
    {
      key: "judge" as const,
      title: "First-pass reviewer",
      description: "Judges every action Auto would otherwise ask about. Fast and cheap. Default: the small model.",
    },
    {
      key: "judge2" as const,
      title: "Second-pass reviewer",
      description:
        "Re-examines only actions the first pass blocks. A capable model pays off here. Default: the first-pass reviewer.",
    },
  ]

  return (
    <Section
      title="Auto approval reviewers"
      description="Models that answer approval cards in the Auto access mode. Blocked actions return to the agent with a reason; reviewer errors fall back to asking you."
    >
      <div class="settings-card">
        <For each={rows}>
          {(row) => (
            <SettingsRow icon="checklist" title={row.title} description={row.description}>
              <Select
                aria-label={row.title}
                options={options()}
                current={selected(current()[row.key])}
                value={(o) => o.value}
                label={(o) => o.label}
                disabled={busy()}
                onSelect={(option) => option && setJudge(row.key, option.value)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>
          )}
        </For>
      </div>
    </Section>
  )
}

interface SettingsRowProps {
  icon: IconProps["name"]
  title: string
  description: string
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="settings-row justify-between">
      <span class="settings-row-logo" aria-hidden="true">
        <Icon name={props.icon} size="small" />
      </span>
      <div class="flex min-w-0 flex-1 basis-[220px] flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="ml-auto max-w-full flex-shrink-0">{props.children}</div>
    </div>
  )
}
