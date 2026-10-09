package online.treehost.crashtest;

import java.util.ArrayList;
import java.util.List;

import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Crashes a test server on purpose, to try Tree Host's crash doctor. Never put it on a real server.
 * Console (or an op):
 *   crashtest freeze   blocks the main thread until the watchdog stops the server ("The server froze")
 *   crashtest memory   fills the memory until Java runs out ("ran out of memory")
 *   crashtest class    asks for a class that doesn't exist, like a plugin built for another version
 */
public final class CrashTest extends JavaPlugin {
    private static final List<long[]> HOARD = new ArrayList<>();

    @Override
    public void onEnable() {
        getLogger().warning("CrashTest is installed: this server can be crashed on purpose (crashtest freeze | memory | class).");
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String what = args.length > 0 ? args[0].toLowerCase() : "";
        switch (what) {
            case "freeze":
                sender.sendMessage("Freezing the main thread: the watchdog stops the server in about a minute.");
                getLogger().warning("CrashTest: freezing the main thread on purpose.");
                long until = System.currentTimeMillis() + 10 * 60 * 1000L;
                while (System.currentTimeMillis() < until) {
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException ignored) {
                    }
                }
                return true;
            case "memory":
                sender.sendMessage("Filling the memory until Java runs out.");
                getLogger().warning("CrashTest: using up all memory on purpose.");
                while (true) HOARD.add(new long[16 * 1024 * 1024]);
            case "class":
                getLogger().warning("CrashTest: loading a class that doesn't exist on purpose.");
                try {
                    Class.forName("net.minecraft.server.v1_8_R3.MinecraftServer");
                } catch (ClassNotFoundException e) {
                    throw new NoClassDefFoundError("net/minecraft/server/v1_8_R3/MinecraftServer");
                }
                return true;
            default:
                sender.sendMessage("crashtest freeze | memory | class");
                return true;
        }
    }
}
