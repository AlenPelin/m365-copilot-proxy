# NixOS module for m365-copilot-proxy.
#
# Runs the Nitro proxy as a hardened systemd service. Sign-in is interactive only,
# and a service has no display, so sign in once on a desktop machine and copy its
# msal-cache.json to /var/lib/m365-copilot-proxy/.config/opencode-m365/ (owned by the
# service). Tokens then refresh silently; msal-cache.json + agent-id.json persist in
# the StateDirectory across restarts.
#
# Imported from the flake as `import ./nix/module.nix self`, where `self` supplies
# the default package for the host's system.
self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.m365-copilot-proxy;
in
{
  options.services.m365-copilot-proxy = {
    enable = lib.mkEnableOption "the M365 Copilot OpenAI-compatible proxy";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.m365-copilot-proxy;
      defaultText = lib.literalExpression "m365-copilot-proxy.packages.\${system}.m365-copilot-proxy";
      description = "The proxy package to run (the wrapper that sets CHROMIUM_PATH and execs the Nitro server).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4141;
      description = "TCP port the proxy listens on.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        Address to bind. Defaults to localhost — this proxy is unauthenticated and
        fronts a paid M365 account, so do not expose it to untrusted networks.
      '';
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open {option}`port` in the firewall. Leave off unless you have a trusted-network reason.";
    };

    chromium = lib.mkOption {
      type = lib.types.package;
      default = pkgs.chromium;
      defaultText = lib.literalExpression "pkgs.chromium";
      description = "Chromium the proxy may launch (CHROMIUM_PATH). The service never opens a sign-in window (M365_NO_INTERACTIVE=1).";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = { M365_TRACE = "1"; };
      description = ''
        Extra environment variables for the service.

        Set `M365_DEBUG = "1"` for truncated debug logging, or `M365_TRACE = "1"`
        for full, untruncated logging (every WS frame, prompt, and response) —
        useful for reverse engineering failures. Both write to a debug file at
        `$STATE_DIRECTORY/.config/opencode-m365/debug.log`
        (i.e. `/var/lib/m365-copilot-proxy/.config/opencode-m365/debug.log`),
        which persists across restarts.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.m365-copilot-proxy = {
      description = "M365 Copilot OpenAI-compatible proxy";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        HOME = "%S/m365-copilot-proxy";
        PORT = toString cfg.port;
        HOST = cfg.host;
        CHROMIUM_PATH = "${cfg.chromium}/bin/chromium";
        # No display: never open the sign-in window. An expired cache fails loudly
        # instead of hanging; re-copy msal-cache.json from a desktop sign-in.
        M365_NO_INTERACTIVE = "1";
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
      } // cfg.environment;

      serviceConfig = {
        ExecStartPre = pkgs.writeShellScript "m365-copilot-proxy-pre" ''
          set -eu
          mkdir -p "$HOME/.config/opencode-m365"
        '';
        ExecStart = "${cfg.package}/bin/m365-copilot-proxy";

        DynamicUser = true;
        StateDirectory = "m365-copilot-proxy";
        StateDirectoryMode = "0700";

        Restart = "on-failure";
        RestartSec = 10;

        # Hardening — kept moderate so headless Chromium (--no-sandbox) can launch.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectControlGroups = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        RestrictNamespaces = false; # Chromium needs user namespaces under --no-sandbox
      };
    };
  };
}
