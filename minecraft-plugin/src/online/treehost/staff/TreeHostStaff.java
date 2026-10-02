package online.treehost.staff;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.Timer;
import java.util.TimerTask;

import org.bukkit.BanList;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerKickEvent;
import org.bukkit.event.player.PlayerLoginEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.server.ServerCommandEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.Team;

import net.md_5.bungee.api.chat.BaseComponent;
import net.md_5.bungee.api.chat.ComponentBuilder;
import net.md_5.bungee.api.chat.HoverEvent;
import net.md_5.bungee.api.chat.TextComponent;

/**
 * Tree Host staff protection. Installed by Tree Host on every Paper / Spigot / Purpur / Folia / CraftBukkit server.
 *
 * Tree Host keeps plugins/TreeHostStaff/staff.txt up to date (one "minecraftName|Role" per line). Staff:
 *  - can always join (whitelist, bans and a full server don't stop them),
 *  - can't be kicked or banned (kick and ban commands on them are refused, bans are undone),
 *  - are announced when they join, in green and gold,
 *  - wear a gold STAFF badge in chat (hover: "Official Tree Host Staff"), above their head and in the player list.
 * Only on online-mode servers (or behind a proxy that checks accounts), so a name really belongs to its owner.
 */
public final class TreeHostStaff extends JavaPlugin implements Listener {
    private static final String BADGE = ChatColor.GOLD + "" + ChatColor.BOLD + "✔ STAFF " + ChatColor.RESET;
    private static final String PREFIX = ChatColor.GREEN + "" + ChatColor.BOLD + "Tree Host " + ChatColor.GOLD + "» ";
    private static final String TEAM = "th_staff";
    private static final Set<String> KICK_BAN_COMMANDS = new HashSet<>(Arrays.asList(
            "kick", "ban", "ban-ip", "banip", "ipban", "tempban", "tempbanip", "tempipban", "mute", "tempmute", "jail",
            "ekick", "eban", "ebanip", "etempban", "kickall", "kill", "minecraft:kick", "minecraft:ban", "minecraft:ban-ip",
            "minecraft:kill", "essentials:kick", "essentials:ban", "essentials:banip", "essentials:tempban", "litebans:ban",
            "litebans:kick", "litebans:tempban", "litebans:ipban", "litebans:mute", "advancedban:ban", "advancedban:kick",
            "advancedban:tempban", "deop", "minecraft:deop"));

    private volatile Map<String, String> staff = Collections.emptyMap(); // lower-case name -> role label
    private File staffFile;
    private long lastModified = -2;
    private Timer timer;
    private boolean components;
    private boolean folia;

    @Override
    public void onEnable() {
        staffFile = new File(getDataFolder(), "staff.txt");
        components = classExists("net.md_5.bungee.api.chat.TextComponent") && classExists("org.bukkit.entity.Player$Spigot");
        folia = classExists("io.papermc.paper.threadedregions.RegionizedServer");
        reload();
        getServer().getPluginManager().registerEvents(this, this);
        timer = new Timer("TreeHostStaff", true);
        timer.scheduleAtFixedRate(new TimerTask() {
            @Override
            public void run() {
                reload();
                runSync(TreeHostStaff.this::undoBans);
            }
        }, 5000L, 5000L);
        getLogger().info("Tree Host staff protection is active (" + staff.size() + " staff, " + (trusted() ? "names verified" : "offline mode: no staff powers") + ").");
    }

    @Override
    public void onDisable() {
        if (timer != null) timer.cancel();
    }

    // ---------- the staff list ----------

    private void reload() {
        long m = staffFile.exists() ? staffFile.lastModified() : -1;
        if (m == lastModified) return;
        lastModified = m;
        Map<String, String> next = new HashMap<>();
        if (m >= 0) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(staffFile), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    String[] parts = line.split("\\|", 2);
                    String name = parts[0].trim();
                    if (!name.matches("[A-Za-z0-9_]{3,16}")) continue;
                    next.put(name.toLowerCase(Locale.ROOT), parts.length > 1 && !parts[1].trim().isEmpty() ? parts[1].trim() : "Staff");
                }
            } catch (Exception e) {
                getLogger().warning("Could not read the Tree Host staff list: " + e.getMessage());
            }
        }
        staff = next;
    }

    /** Names are only trustworthy when Mojang checked them: online mode, or behind a BungeeCord/Velocity proxy. */
    private boolean trusted() {
        if (getServer().getOnlineMode()) return true;
        try {
            return getServer().spigot().getConfig().getBoolean("settings.bungeecord");
        } catch (Throwable t) {
            return false;
        }
    }

    private String roleOf(String name) {
        if (name == null || !trusted()) return null;
        return staff.get(name.toLowerCase(Locale.ROOT));
    }

    // ---------- always let staff in ----------

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPreLogin(AsyncPlayerPreLoginEvent e) {
        if (roleOf(e.getName()) != null && e.getLoginResult() != AsyncPlayerPreLoginEvent.Result.ALLOWED) {
            e.allow();
            runSync(() -> pardon(e.getName()));
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onLogin(PlayerLoginEvent e) {
        if (roleOf(e.getPlayer().getName()) != null && e.getResult() != PlayerLoginEvent.Result.ALLOWED) {
            e.allow();
            pardon(e.getPlayer().getName());
        }
    }

    // ---------- no kicks or bans ----------

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onKick(PlayerKickEvent e) {
        Player p = e.getPlayer();
        String role = roleOf(p.getName());
        if (role == null || stopping(e.getReason())) return;
        e.setCancelled(true);
        p.sendMessage(PREFIX + ChatColor.YELLOW + "Someone tried to kick you (" + ChatColor.stripColor(String.valueOf(e.getReason())) + "). Staff can't be kicked.");
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onPlayerCommand(PlayerCommandPreprocessEvent e) {
        if (blocked(e.getPlayer(), e.getMessage())) e.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onConsoleCommand(ServerCommandEvent e) {
        if (blocked(e.getSender(), e.getCommand())) e.setCancelled(true);
    }

    /** Refuses kick / ban / kill / deop commands aimed at staff (names or their IP address). */
    private boolean blocked(CommandSender sender, String command) {
        String[] args = command.trim().replaceFirst("^/", "").split("\\s+");
        if (args.length < 2 || !KICK_BAN_COMMANDS.contains(args[0].toLowerCase(Locale.ROOT))) return false;
        // The target is the first argument that isn't a flag (e.g. "tempban -s Steve 1d"); the rest is the reason.
        String target = null;
        for (int i = 1; i < args.length && target == null; i++) if (!args[i].startsWith("-")) target = args[i];
        if (target == null) return false;
        String role = roleOf(target);
        Player online = role != null ? null : ipOwner(target);
        if (role == null && online != null) role = roleOf(online.getName());
        if (role == null) return false;
        sender.sendMessage(PREFIX + ChatColor.YELLOW + (online != null ? online.getName() : target) + " is official Tree Host staff and can't be kicked or banned.");
        return true;
    }

    private Player ipOwner(String ip) {
        if (!ip.matches("[0-9a-fA-F.:]{7,45}")) return null;
        for (Player p : getServer().getOnlinePlayers()) {
            if (p.getAddress() != null && p.getAddress().getAddress() != null && ip.equals(p.getAddress().getAddress().getHostAddress())) return p;
        }
        return null;
    }

    private void undoBans() {
        if (!trusted()) return;
        for (String name : staff.keySet()) pardon(name);
        for (Player p : getServer().getOnlinePlayers()) {
            if (roleOf(p.getName()) == null || p.getAddress() == null || p.getAddress().getAddress() == null) continue;
            String ip = p.getAddress().getAddress().getHostAddress();
            try {
                BanList ips = getServer().getBanList(BanList.Type.IP);
                if (ips.isBanned(ip)) ips.pardon(ip);
            } catch (Throwable ignored) {
            }
        }
    }

    private void pardon(String name) {
        try {
            BanList names = getServer().getBanList(BanList.Type.NAME);
            if (names.isBanned(name)) {
                names.pardon(name);
                getLogger().info("Undid a ban on Tree Host staff " + name + ".");
            }
        } catch (Throwable ignored) {
        }
    }

    // ---------- join notice and badges ----------

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onJoin(PlayerJoinEvent e) {
        Player p = e.getPlayer();
        String role = roleOf(p.getName());
        if (role == null) return;
        e.setJoinMessage(BADGE + ChatColor.GOLD + p.getName() + ChatColor.YELLOW + " (" + role + ") joined the game");
        try {
            p.setPlayerListName(BADGE + ChatColor.GOLD + p.getName());
        } catch (Throwable ignored) {
        }
        try {
            Scoreboard board = getServer().getScoreboardManager().getMainScoreboard();
            Team team = board.getTeam(TEAM);
            if (team == null) team = board.registerNewTeam(TEAM);
            team.setPrefix(BADGE);
            try {
                team.setColor(ChatColor.GOLD);
            } catch (Throwable ignored) {
            }
            team.addEntry(p.getName());
        } catch (Throwable ignored) {
            // Folia has no scoreboards; the chat and player list badges still work.
        }
        String text = PREFIX + ChatColor.GOLD + "" + ChatColor.BOLD + p.getName() + ChatColor.GOLD + " (" + role + ") joined. "
                + ChatColor.GREEN + "A Tree Host " + role + " has joined your server.";
        for (Player other : getServer().getOnlinePlayers()) {
            if (components) {
                try {
                    other.spigot().sendMessage(withHover(text, "Official Tree Host Staff"));
                    continue;
                } catch (Throwable ignored) {
                }
            }
            other.sendMessage(text);
        }
        getServer().getConsoleSender().sendMessage(ChatColor.stripColor(text));
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        if (roleOf(e.getPlayer().getName()) == null) return;
        try {
            Team team = getServer().getScoreboardManager().getMainScoreboard().getTeam(TEAM);
            if (team != null) team.removeEntry(e.getPlayer().getName());
        } catch (Throwable ignored) {
        }
    }

    /** Staff chat: a gold STAFF badge before the name; hovering over it says "Official Tree Host Staff". */
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent e) {
        Player p = e.getPlayer();
        String role = roleOf(p.getName());
        if (role == null) return;
        if (!components) {
            e.setFormat(BADGE + ChatColor.GOLD + "%1$s" + ChatColor.GRAY + ": " + ChatColor.WHITE + "%2$s");
            return;
        }
        e.setCancelled(true);
        BaseComponent[] badge = new ComponentBuilder("✔ STAFF ").color(net.md_5.bungee.api.ChatColor.GOLD).bold(true)
                .event(new HoverEvent(HoverEvent.Action.SHOW_TEXT, new ComponentBuilder("Official Tree Host Staff\n").color(net.md_5.bungee.api.ChatColor.GREEN).bold(true)
                        .append(role).color(net.md_5.bungee.api.ChatColor.GOLD).bold(false).create()))
                .create();
        BaseComponent[] rest = new ComponentBuilder(p.getName()).color(net.md_5.bungee.api.ChatColor.GOLD).bold(false).event((HoverEvent) null)
                .append(": ").color(net.md_5.bungee.api.ChatColor.GRAY)
                .append(e.getMessage()).color(net.md_5.bungee.api.ChatColor.WHITE).create();
        BaseComponent[] line = new BaseComponent[badge.length + rest.length];
        System.arraycopy(badge, 0, line, 0, badge.length);
        System.arraycopy(rest, 0, line, badge.length, rest.length);
        for (Player r : e.getRecipients()) {
            try {
                r.spigot().sendMessage(line);
            } catch (Throwable t) {
                r.sendMessage(BADGE + ChatColor.GOLD + p.getName() + ChatColor.GRAY + ": " + ChatColor.WHITE + e.getMessage());
            }
        }
        getServer().getConsoleSender().sendMessage("[STAFF] " + p.getName() + ": " + e.getMessage());
    }

    // ---------- helpers ----------

    private static BaseComponent[] withHover(String legacy, String hover) {
        BaseComponent[] parts = TextComponent.fromLegacyText(legacy);
        HoverEvent ev = new HoverEvent(HoverEvent.Action.SHOW_TEXT, new ComponentBuilder(hover).color(net.md_5.bungee.api.ChatColor.GREEN).create());
        for (BaseComponent c : parts) c.setHoverEvent(ev);
        return parts;
    }

    /** True while the server is shutting down (its "server closed" kicks must go through). */
    private boolean stopping(String reason) {
        try {
            Object r = Bukkit.class.getMethod("isStopping").invoke(null);
            if (Boolean.TRUE.equals(r)) return true;
        } catch (Throwable ignored) {
        }
        String why = String.valueOf(reason).toLowerCase(Locale.ROOT);
        return why.contains("server closed") || why.contains("shutting down") || why.contains("restarting") || why.contains("server is stopping");
    }

    private void runSync(Runnable task) {
        if (folia || !isEnabled()) {
            try {
                task.run();
            } catch (Throwable ignored) {
            }
            return;
        }
        try {
            getServer().getScheduler().runTask(this, task);
        } catch (Throwable ignored) {
        }
    }

    private static boolean classExists(String name) {
        try {
            Class.forName(name);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
