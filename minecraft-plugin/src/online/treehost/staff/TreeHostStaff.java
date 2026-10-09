package online.treehost.staff;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
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
import org.bukkit.OfflinePlayer;
import org.bukkit.command.Command;
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
import org.bukkit.event.server.ServerListPingEvent;
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
 *  - wear a gold STAFF badge in chat (hover: "Official Tree Host Staff"), above their head and in the player list,
 *  - are made operator while they're on the server when their role may run commands ("#op=name" lines); it's taken
 *    away again when they leave, and an owner's own ops are never touched (granted-ops.txt remembers which ones),
 *  - get /sc (staff chat), /thvanish (hidden from players), /thinfo (server health) and /thstaff (help),
 *  - have every command they run written to the console and plugins/TreeHostStaff/staff-actions.log, so the owner
 *    can see what staff did on their server.
 * Only on online-mode servers (or behind a proxy that checks accounts), so a name really belongs to its owner.
 *
 * Creators (YouTubers) are in plugins/TreeHostStaff/creators.txt ("minecraftName|Label|perk,perk"), with the perks
 * Tree Host staff gave their role:
 *  - badge:     a red "▶ YOUTUBER" tag above their head, in chat and in the player list,
 *  - announce:  everyone is told when they join,
 *  - joinfull:  they can join when the server is full,
 *  - whitelist: they can join through the whitelist.
 * Creators get no protection from kicks or bans: those stay the owner's call.
 */
public final class TreeHostStaff extends JavaPlugin implements Listener {
    private static final String BADGE = ChatColor.GOLD + "" + ChatColor.BOLD + "✔ STAFF " + ChatColor.RESET;
    private static final String PREFIX = ChatColor.GREEN + "" + ChatColor.BOLD + "Tree Host " + ChatColor.GOLD + "» ";
    private static final String TEAM = "th_staff";
    private static final String CREATOR_TEAM = "th_creator";
    private static final Set<String> KICK_BAN_COMMANDS = new HashSet<>(Arrays.asList(
            "kick", "ban", "ban-ip", "banip", "ipban", "tempban", "tempbanip", "tempipban", "mute", "tempmute", "jail",
            "ekick", "eban", "ebanip", "etempban", "kickall", "kill", "minecraft:kick", "minecraft:ban", "minecraft:ban-ip",
            "minecraft:kill", "essentials:kick", "essentials:ban", "essentials:banip", "essentials:tempban", "litebans:ban",
            "litebans:kick", "litebans:tempban", "litebans:ipban", "litebans:mute", "advancedban:ban", "advancedban:kick",
            "advancedban:tempban", "deop", "minecraft:deop"));

    private volatile Map<String, String> staff = Collections.emptyMap(); // lower-case name -> role label
    private volatile Set<String> opStaff = Collections.emptySet(); // lower-case names whose role may be made operator
    private final Set<String> grantedOps = Collections.synchronizedSet(new HashSet<String>()); // ops this plugin gave
    private final Set<String> vanished = Collections.synchronizedSet(new HashSet<String>()); // lower-case names
    private File grantedFile;
    private File actionsFile;
    private volatile Map<String, Creator> creators = Collections.emptyMap(); // lower-case name -> label and perks
    private File creatorsFile;
    private long creatorsModified = -2;
    private volatile boolean proxyTrusted; // Tree Host put this server behind its owner's proxy, which checks accounts
    private volatile String[] motdFrames = new String[0]; // the owner's MOTD (several frames = animated)
    private volatile int motdInterval = 3;
    private File motdFile;
    private long motdModified = -2;
    private File staffFile;
    private long lastModified = -2;
    private Timer timer;
    private boolean components;
    private boolean folia;

    @Override
    public void onEnable() {
        staffFile = new File(getDataFolder(), "staff.txt");
        creatorsFile = new File(getDataFolder(), "creators.txt");
        motdFile = new File(getDataFolder(), "motd.txt");
        grantedFile = new File(getDataFolder(), "granted-ops.txt");
        actionsFile = new File(getDataFolder(), "staff-actions.log");
        loadGrantedOps();
        components = classExists("net.md_5.bungee.api.chat.TextComponent") && classExists("org.bukkit.entity.Player$Spigot");
        folia = classExists("io.papermc.paper.threadedregions.RegionizedServer");
        reload();
        reloadCreators();
        reloadMotd();
        getServer().getPluginManager().registerEvents(this, this);
        timer = new Timer("TreeHostStaff", true);
        timer.scheduleAtFixedRate(new TimerTask() {
            @Override
            public void run() {
                reload();
                reloadCreators();
                reloadMotd();
                runSync(TreeHostStaff.this::undoBans);
                runSync(TreeHostStaff.this::syncOps);
            }
        }, 5000L, 5000L);
        // Ops left over from a crash (the staff member wasn't here to leave): take them back now.
        runSync(this::syncOps);
        getLogger().info("Tree Host staff protection is active (" + staff.size() + " staff, " + creators.size() + " creators, " + (trusted() ? "names verified" : "offline mode: no staff powers") + ").");
    }

    @Override
    public void onDisable() {
        if (timer != null) timer.cancel();
        // Stopping: staff stop being operator (they get it back when they join again).
        for (String name : new HashSet<>(grantedOps)) deop(name);
    }

    // ---------- the staff list ----------

    private void reload() {
        long m = staffFile.exists() ? staffFile.lastModified() : -1;
        if (m == lastModified) return;
        lastModified = m;
        Map<String, String> next = new HashMap<>();
        Set<String> ops = new HashSet<>();
        boolean trust = false;
        if (m >= 0) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(staffFile), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    line = line.trim();
                    if (line.equals("#trust=proxy")) trust = true;
                    if (line.startsWith("#op=")) ops.add(line.substring(4).trim().toLowerCase(Locale.ROOT));
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
        opStaff = ops;
        proxyTrusted = trust;
    }

    // ---------- creators (YouTubers) ----------

    private static final class Creator {
        final String label;
        final Set<String> perks;

        Creator(String label, Set<String> perks) {
            this.label = label;
            this.perks = perks;
        }

        boolean has(String perk) {
            return perks.contains(perk);
        }

        /** "▶ YOUTUBER " in red, for nametags, the player list and chat. */
        String badge() {
            return ChatColor.RED + "" + ChatColor.BOLD + "▶ " + label.toUpperCase(Locale.ROOT) + " " + ChatColor.RESET;
        }
    }

    private void reloadCreators() {
        long m = creatorsFile.exists() ? creatorsFile.lastModified() : -1;
        if (m == creatorsModified) return;
        creatorsModified = m;
        Map<String, Creator> next = new HashMap<>();
        if (m >= 0) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(creatorsFile), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    String[] parts = line.split("\\|", 3);
                    String name = parts[0].trim();
                    if (!name.matches("[A-Za-z0-9_]{3,16}")) continue;
                    String label = parts.length > 1 && parts[1].trim().matches("[A-Za-z0-9 ]{1,16}") ? parts[1].trim() : "YouTuber";
                    Set<String> perks = new HashSet<>();
                    if (parts.length > 2) for (String p : parts[2].split(",")) if (!p.trim().isEmpty()) perks.add(p.trim().toLowerCase(Locale.ROOT));
                    next.put(name.toLowerCase(Locale.ROOT), new Creator(label, perks));
                }
            } catch (Exception e) {
                getLogger().warning("Could not read the Tree Host creator list: " + e.getMessage());
            }
        }
        creators = next;
    }

    /** A creator's perks (null for everyone else, for staff, and on servers where names can't be trusted). */
    private Creator creatorOf(String name) {
        if (name == null || !trusted() || roleOf(name) != null) return null;
        return creators.get(name.toLowerCase(Locale.ROOT));
    }

    /** motd.txt from Tree Host: "#interval=3", then frames (1-2 lines each, section codes) separated by "---". */
    private void reloadMotd() {
        long m = motdFile.exists() ? motdFile.lastModified() : -1;
        if (m == motdModified) return;
        motdModified = m;
        java.util.List<String> frames = new java.util.ArrayList<>();
        int interval = 3;
        if (m >= 0) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(motdFile), StandardCharsets.UTF_8))) {
                StringBuilder frame = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) {
                    if (line.startsWith("#interval=")) {
                        try {
                            interval = Math.max(1, Math.min(60, Integer.parseInt(line.substring(10).trim())));
                        } catch (NumberFormatException ignored) {
                        }
                        continue;
                    }
                    if (line.equals("---")) {
                        if (frame.length() > 0) frames.add(frame.toString());
                        frame.setLength(0);
                        continue;
                    }
                    if (frame.length() > 0) frame.append("\n");
                    frame.append(line);
                }
                if (frame.length() > 0) frames.add(frame.toString());
            } catch (Exception e) {
                getLogger().warning("Could not read the MOTD: " + e.getMessage());
            }
        }
        motdInterval = interval;
        motdFrames = frames.toArray(new String[0]);
    }

    /** The server list message: the owner's MOTD, a new frame every few seconds when it's animated. */
    @EventHandler(priority = EventPriority.HIGH)
    public void onPing(ServerListPingEvent e) {
        String[] frames = motdFrames;
        if (frames.length == 0) return;
        int i = (int) ((System.currentTimeMillis() / (motdInterval * 1000L)) % frames.length);
        try {
            e.setMotd(frames[i]);
        } catch (Throwable ignored) {
        }
    }

    /** Names are only trustworthy when Mojang checked them: online mode, or behind a BungeeCord/Velocity proxy. */
    private boolean trusted() {
        if (getServer().getOnlineMode() || proxyTrusted) return true;
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
            return;
        }
        Creator c = creatorOf(e.getName());
        AsyncPlayerPreLoginEvent.Result r = e.getLoginResult();
        if (c != null && ((r == AsyncPlayerPreLoginEvent.Result.KICK_FULL && c.has("joinfull")) || (r == AsyncPlayerPreLoginEvent.Result.KICK_WHITELIST && c.has("whitelist")))) e.allow();
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onLogin(PlayerLoginEvent e) {
        if (roleOf(e.getPlayer().getName()) != null && e.getResult() != PlayerLoginEvent.Result.ALLOWED) {
            e.allow();
            pardon(e.getPlayer().getName());
            return;
        }
        // Creators: only a full server or the whitelist, never a ban (that's the owner's decision).
        Creator c = creatorOf(e.getPlayer().getName());
        PlayerLoginEvent.Result r = e.getResult();
        if (c != null && ((r == PlayerLoginEvent.Result.KICK_FULL && c.has("joinfull")) || (r == PlayerLoginEvent.Result.KICK_WHITELIST && c.has("whitelist")))) e.allow();
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
        String role = roleOf(e.getPlayer().getName());
        // Staff chat is logged by /sc itself; everything else staff run is written down for the owner.
        if (role != null && !e.getMessage().matches("(?i)^/(sc|thchat|treehoststaff:sc|treehoststaff:thchat)( .*)?$")) {
            logAction(e.getPlayer().getName() + " (" + role + ") ran: " + e.getMessage());
        }
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
        if (role == null) {
            hideVanishedFrom(p);
            creatorJoined(e, p);
            return;
        }
        grantOp(p);
        p.sendMessage(PREFIX + ChatColor.GREEN + "Staff tools: " + ChatColor.WHITE + "/sc" + ChatColor.GRAY + " staff chat, "
                + ChatColor.WHITE + "/thvanish" + ChatColor.GRAY + ", " + ChatColor.WHITE + "/thinfo" + ChatColor.GRAY + ", "
                + ChatColor.WHITE + "/thstaff" + ChatColor.GRAY + "." + (p.isOp() ? " You're operator while you're here." : ""));
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

    /** A creator joins: their badge above their head and in the player list, and the announcement. */
    private void creatorJoined(PlayerJoinEvent e, Player p) {
        Creator c = creatorOf(p.getName());
        if (c == null) return;
        if (c.has("badge")) {
            try {
                p.setPlayerListName(c.badge() + ChatColor.WHITE + p.getName());
            } catch (Throwable ignored) {
            }
            try {
                Scoreboard board = getServer().getScoreboardManager().getMainScoreboard();
                Team team = board.getTeam(CREATOR_TEAM);
                if (team == null) team = board.registerNewTeam(CREATOR_TEAM);
                team.setPrefix(c.badge());
                try {
                    team.setColor(ChatColor.WHITE);
                } catch (Throwable ignored) {
                }
                team.addEntry(p.getName());
            } catch (Throwable ignored) {
                // Folia has no scoreboards; the chat and player list badges still work.
            }
        }
        if (c.has("announce")) {
            e.setJoinMessage(null);
            String text = ChatColor.RED + "" + ChatColor.BOLD + "▶ " + ChatColor.WHITE + ChatColor.BOLD + p.getName() + ChatColor.RESET + ChatColor.GRAY
                    + " joined the game. " + ChatColor.RED + c.label + ChatColor.GRAY + " on Tree Host";
            for (Player other : getServer().getOnlinePlayers()) {
                if (components) {
                    try {
                        other.spigot().sendMessage(withHover(text, "Tree Host " + c.label));
                        continue;
                    } catch (Throwable ignored) {
                    }
                }
                other.sendMessage(text);
            }
            getServer().getConsoleSender().sendMessage(ChatColor.stripColor(text));
        }
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        String name = e.getPlayer().getName();
        vanished.remove(name.toLowerCase(Locale.ROOT));
        if (grantedOps.contains(name.toLowerCase(Locale.ROOT))) deop(name);
        String team = roleOf(name) != null ? TEAM : creatorOf(name) != null ? CREATOR_TEAM : null;
        if (team == null) return;
        try {
            Team t = getServer().getScoreboardManager().getMainScoreboard().getTeam(team);
            if (t != null) t.removeEntry(name);
        } catch (Throwable ignored) {
        }
    }

    /** Staff chat: a gold STAFF badge before the name; hovering over it says "Official Tree Host Staff". */
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent e) {
        Player p = e.getPlayer();
        String role = roleOf(p.getName());
        if (role == null) {
            // Creators: the badge goes in front of whatever chat format the server uses (other chat plugins keep working).
            Creator c = creatorOf(p.getName());
            if (c != null && c.has("badge")) e.setFormat(c.badge() + e.getFormat());
            return;
        }
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

    // ---------- operator while staff are on the server ----------

    private boolean mayOp(String name) {
        return name != null && roleOf(name) != null && opStaff.contains(name.toLowerCase(Locale.ROOT));
    }

    /** Makes a staff member operator (unless the owner already did: then it stays theirs to manage). */
    private void grantOp(Player p) {
        if (!mayOp(p.getName()) || p.isOp()) return;
        try {
            p.setOp(true);
            grantedOps.add(p.getName().toLowerCase(Locale.ROOT));
            saveGrantedOps();
            logAction(p.getName() + " was made operator (Tree Host staff; taken away again when they leave).");
        } catch (Throwable t) {
            getLogger().warning("Could not make " + p.getName() + " operator: " + t.getMessage());
        }
    }

    private void deop(String name) {
        try {
            Player online = getServer().getPlayerExact(name);
            OfflinePlayer target = online != null ? online : getServer().getOfflinePlayer(name);
            if (target.isOp()) target.setOp(false);
        } catch (Throwable ignored) {
        }
        grantedOps.remove(name.toLowerCase(Locale.ROOT));
        saveGrantedOps();
    }

    /** Ops this plugin gave go away when the person left, or isn't staff (or allowed op) any more. */
    private void syncOps() {
        for (String name : new HashSet<>(grantedOps)) {
            Player p = getServer().getPlayerExact(name);
            if (p == null || !mayOp(name)) deop(name);
        }
        for (Player p : getServer().getOnlinePlayers()) if (mayOp(p.getName())) grantOp(p);
    }

    private void loadGrantedOps() {
        if (!grantedFile.exists()) return;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(grantedFile), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) if (line.trim().matches("[A-Za-z0-9_]{3,16}")) grantedOps.add(line.trim().toLowerCase(Locale.ROOT));
        } catch (Exception e) {
            getLogger().warning("Could not read granted-ops.txt: " + e.getMessage());
        }
    }

    private void saveGrantedOps() {
        try {
            getDataFolder().mkdirs();
            try (Writer w = new OutputStreamWriter(new FileOutputStream(grantedFile), StandardCharsets.UTF_8)) {
                w.write("# Tree Host staff this plugin made operator (taken away when they leave). Don't edit.\n");
                synchronized (grantedOps) {
                    for (String n : grantedOps) w.write(n + "\n");
                }
            }
        } catch (Exception e) {
            getLogger().warning("Could not save granted-ops.txt: " + e.getMessage());
        }
    }

    /** What staff did on this server: in the console and in staff-actions.log, for the owner to read. */
    private void logAction(String text) {
        getLogger().info("[Tree Host staff] " + text);
        try {
            getDataFolder().mkdirs();
            try (Writer w = new OutputStreamWriter(new FileOutputStream(actionsFile, true), StandardCharsets.UTF_8)) {
                w.write(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date()) + "  " + text + "\n");
            }
        } catch (Exception ignored) {
        }
    }

    // ---------- staff commands ----------

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String name = command.getName().toLowerCase(Locale.ROOT);
        String role = sender instanceof Player ? roleOf(sender.getName()) : "Console";
        if (role == null) {
            sender.sendMessage(PREFIX + ChatColor.RED + "That command is for official Tree Host staff.");
            return true;
        }
        switch (name) {
            case "thchat":
                if (args.length == 0) {
                    sender.sendMessage(PREFIX + ChatColor.YELLOW + "Usage: /sc <message>  (only Tree Host staff on this server see it)");
                    return true;
                }
                String msg = String.join(" ", args);
                String line = ChatColor.GOLD + "" + ChatColor.BOLD + "[Staff] " + ChatColor.GOLD + sender.getName() + ChatColor.GRAY + ": " + ChatColor.AQUA + msg;
                for (Player p : getServer().getOnlinePlayers()) if (roleOf(p.getName()) != null) p.sendMessage(line);
                if (!(sender instanceof Player)) sender.sendMessage(line);
                logAction("[staff chat] " + sender.getName() + ": " + msg);
                return true;
            case "thvanish":
                if (!(sender instanceof Player)) {
                    sender.sendMessage("Only players can vanish.");
                    return true;
                }
                Player me = (Player) sender;
                String key = me.getName().toLowerCase(Locale.ROOT);
                boolean hide = !vanished.contains(key);
                if (hide) vanished.add(key);
                else vanished.remove(key);
                for (Player other : getServer().getOnlinePlayers()) {
                    if (other == me || roleOf(other.getName()) != null) continue;
                    try {
                        if (hide) other.hidePlayer(this, me);
                        else other.showPlayer(this, me);
                    } catch (Throwable ignored) {
                    }
                }
                me.sendMessage(PREFIX + (hide ? ChatColor.GREEN + "You're vanished: players can't see you (staff still can). /thvanish again to show yourself."
                        : ChatColor.YELLOW + "You're visible again."));
                logAction(me.getName() + (hide ? " vanished." : " is visible again."));
                return true;
            case "thinfo":
                sendInfo(sender);
                return true;
            default:
                sender.sendMessage(PREFIX + ChatColor.GREEN + "Official Tree Host staff tools" + ChatColor.GRAY + " (" + role + ")");
                sender.sendMessage(ChatColor.WHITE + "  /sc <message>" + ChatColor.GRAY + "  chat with the other Tree Host staff on this server");
                sender.sendMessage(ChatColor.WHITE + "  /thvanish" + ChatColor.GRAY + "  hide from players while you look into a problem");
                sender.sendMessage(ChatColor.WHITE + "  /thinfo" + ChatColor.GRAY + "  TPS, memory, players, plugins and version at a glance");
                sender.sendMessage(ChatColor.GRAY + "  You " + (sender instanceof Player && ((Player) sender).isOp() ? "are" : "aren't") + " operator. Staff can't be kicked or banned."
                        + " Everything you run here is logged for the owner.");
                return true;
        }
    }

    /** Server health for staff: TPS (Paper), memory, players, plugins, version. */
    private void sendInfo(CommandSender to) {
        Runtime rt = Runtime.getRuntime();
        long used = (rt.totalMemory() - rt.freeMemory()) / 1048576L, max = rt.maxMemory() / 1048576L;
        String tps = "not available on this server type";
        try {
            double[] t = (double[]) getServer().getClass().getMethod("getTPS").invoke(getServer());
            tps = String.format(Locale.ROOT, "%.1f, %.1f, %.1f (1, 5, 15 min)", Math.min(20, t[0]), Math.min(20, t[1]), Math.min(20, t[2]));
        } catch (Throwable ignored) {
        }
        StringBuilder plugins = new StringBuilder();
        org.bukkit.plugin.Plugin[] list = getServer().getPluginManager().getPlugins();
        for (org.bukkit.plugin.Plugin pl : list) {
            if (plugins.length() > 0) plugins.append(", ");
            plugins.append(pl.isEnabled() ? ChatColor.WHITE : ChatColor.RED).append(pl.getName()).append(ChatColor.GRAY);
        }
        to.sendMessage(PREFIX + ChatColor.GREEN + "Server health");
        to.sendMessage(ChatColor.GRAY + "  Version: " + ChatColor.WHITE + getServer().getName() + " " + getServer().getBukkitVersion());
        to.sendMessage(ChatColor.GRAY + "  TPS: " + ChatColor.WHITE + tps);
        to.sendMessage(ChatColor.GRAY + "  Memory: " + ChatColor.WHITE + used + " / " + max + " MB" + (used * 100 / Math.max(1, max) > 85 ? ChatColor.RED + " (nearly full)" : ""));
        to.sendMessage(ChatColor.GRAY + "  Players: " + ChatColor.WHITE + getServer().getOnlinePlayers().size() + " / " + getServer().getMaxPlayers()
                + ChatColor.GRAY + "  View distance: " + ChatColor.WHITE + getServer().getViewDistance() + ChatColor.GRAY + "  Online mode: " + ChatColor.WHITE + getServer().getOnlineMode());
        to.sendMessage(ChatColor.GRAY + "  Plugins (" + list.length + ", red = off): " + plugins);
    }

    /** Someone who isn't staff joins: staff who vanished stay hidden from them. */
    private void hideVanishedFrom(Player newcomer) {
        synchronized (vanished) {
            for (String n : vanished) {
                Player v = getServer().getPlayerExact(n);
                if (v == null) continue;
                try {
                    newcomer.hidePlayer(this, v);
                } catch (Throwable ignored) {
                }
            }
        }
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
