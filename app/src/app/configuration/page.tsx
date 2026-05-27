import { createFileRoute } from "@tanstack/react-router";
import { RotateCcw, Save } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MethodConfig } from "./-components/MethodConfig";
import { StrategyConfig } from "./-components/StrategyConfig";
import { useConfigurationStore } from "./-stores/configuration-store";

function ConfigurationRouteComponent() {
  const config = useConfigurationStore((state) => state.config);
  const loading = useConfigurationStore((state) => state.loading);
  const saving = useConfigurationStore((state) => state.saving);
  const initializeConfig = useConfigurationStore(
    (state) => state.initializeConfig,
  );
  const saveConfig = useConfigurationStore((state) => state.saveConfig);
  const resetConfig = useConfigurationStore((state) => state.resetConfig);

  useEffect(() => {
    if (!config) {
      initializeConfig();
    }
  }, [config, initializeConfig]);

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto p-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold bg-linear-to-r from-primary to-purple-500 bg-clip-text text-transparent">
            Biopass Configuration
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your authentication methods and execution strategies
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={resetConfig}
            className="flex items-center gap-2 cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" />
            Reset
          </Button>
          <Button
            onClick={saveConfig}
            disabled={saving}
            className="flex items-center gap-2 cursor-pointer"
          >
            <Save className="w-4 h-4" />
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid gap-6">
        <StrategyConfig />
        <MethodConfig />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/configuration/")({
  component: ConfigurationRouteComponent,
});
