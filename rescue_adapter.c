/*
 * JSON line adapter for the original Rescue Navigator C implementation.
 * Build from the project root:
 *   gcc -std=c99 -O2 rescue_adapter.c -o rescue_engine
 * The process accepts one JSON command per line and retains its map in memory.
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <stdarg.h>

static int rescue_silent_printf(const char *format, ...) {
    (void)format;
    return 0;
}
#define printf rescue_silent_printf
#include "src/rescue.c"
#undef printf

static RescueMap map_data;

static int json_get_string(const char *json, const char *key, char *out, size_t size) {
    char pattern[80];
    const char *p;
    size_t n = 0;
    if (snprintf(pattern, sizeof(pattern), "\"%s\"", key) >= (int)sizeof(pattern)) return 0;
    p = strstr(json, pattern);
    if (!p || !(p = strchr(p + strlen(pattern), ':'))) return 0;
    p++;
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p++ != '"') return 0;
    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\' && *p) {
            c = *p++;
            if (c == 'n') c = '\n';
            else if (c == 'r') c = '\r';
            else if (c == 't') c = '\t';
        }
        if (n + 1 < size) out[n++] = c;
    }
    if (*p != '"') return 0;
    out[n] = '\0';
    return 1;
}

static int json_get_int(const char *json, const char *key, int *value) {
    char pattern[80];
    const char *p;
    char *end;
    long v;
    if (snprintf(pattern, sizeof(pattern), "\"%s\"", key) >= (int)sizeof(pattern)) return 0;
    p = strstr(json, pattern);
    if (!p || !(p = strchr(p + strlen(pattern), ':'))) return 0;
    p++;
    while (*p && isspace((unsigned char)*p)) p++;
    v = strtol(p, &end, 10);
    if (end == p || v < -2147483647L - 1L || v > 2147483647L) return 0;
    *value = (int)v;
    return 1;
}

static void json_string(const char *s) {
    putchar('"');
    while (*s) {
        unsigned char c = (unsigned char)*s++;
        if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
        else if (c == '\n') fputs("\\n", stdout);
        else if (c == '\r') fputs("\\r", stdout);
        else if (c == '\t') fputs("\\t", stdout);
        else if (c < 32) printf("\\u%04x", c);
        else putchar(c);
    }
    putchar('"');
}

static void error_json(const char *message) {
    fputs("{\"ok\":false,\"error\":", stdout);
    json_string(message);
    fputs("}\n", stdout);
}

static void handle_map(void) {
    int i, j, first = 1;
    fputs("{\"ok\":true,\"locations\":[", stdout);
    for (i = 0; i < map_data.nodes; i++) {
        if (i) putchar(',');
        json_string(map_data.names[i]);
    }
    fputs("],\"roads\":[", stdout);
    for (i = 0; i < map_data.nodes; i++) {
        for (j = i + 1; j < map_data.nodes; j++) {
            if (map_data.graph[i][j] == INF) continue;
            if (!first) putchar(',');
            first = 0;
            putchar('[');
            json_string(map_data.names[i]);
            putchar(',');
            json_string(map_data.names[j]);
            printf(",%d,%s]", map_data.graph[i][j],
                   map_data.blocked[i][j] ? "true" : "false");
        }
    }
    fputs("]}\n", stdout);
}

static void handle_route(const char *source_name, const char *destination_name) {
    int source = findLocation(&map_data, (char *)source_name);
    int destination = findLocation(&map_data, (char *)destination_name);
    int dist[MAX], visited[MAX], parent[MAX], i, count, u, v;

    if (source < 0 || destination < 0) {
        error_json("Invalid source or destination location.");
        return;
    }
    for (i = 0; i < map_data.nodes; i++) {
        dist[i] = INF; visited[i] = 0; parent[i] = -1;
    }
    dist[source] = 0;

    for (count = 0; count < map_data.nodes - 1; count++) {
        u = minDistance(dist, visited, map_data.nodes);
        if (u == -1) break;
        visited[u] = 1;
        for (v = 0; v < map_data.nodes; v++) {
            int cost = map_data.graph[u][v];
            if (!visited[v] && cost != INF && !map_data.blocked[u][v] &&
                dist[u] != INF && dist[u] + cost < dist[v]) {
                dist[v] = dist[u] + cost;
                parent[v] = u;
            }
        }
    }

    if (dist[destination] == INF) {
        fputs("{\"ok\":true,\"found\":false,\"message\":", stdout);
        json_string("No safe route available to destination.");
        fputs("}\n", stdout);
        return;
    }

    {
        int reverse_path[MAX], length = 0, current = destination;
        while (current != -1 && length < MAX) {
            reverse_path[length++] = current;
            current = parent[current];
        }
        fputs("{\"ok\":true,\"found\":true,\"route\":[", stdout);
        for (i = length - 1; i >= 0; i--) {
            if (i != length - 1) putchar(',');
            json_string(map_data.names[reverse_path[i]]);
        }
        printf("],\"totalCost\":%d,\"estimatedTimeMinutes\":%d}\n",
               dist[destination], dist[destination] * 2);
    }
}

int main(void) {
    char line[4096], command[40], name[30], from[30], to[30], source[30], destination[30];
    int cost, u, v;
    initializeMap(&map_data);

    while (fgets(line, sizeof(line), stdin)) {
        if (!json_get_string(line, "command", command, sizeof(command))) {
            error_json("Missing or invalid command."); continue;
        }
        if (!strcmp(command, "init")) {
            initializeMap(&map_data);
            fputs("{\"ok\":true}\n", stdout);
        } else if (!strcmp(command, "addLocation")) {
            if (!json_get_string(line, "name", name, sizeof(name))) error_json("Missing location name.");
            else if (strlen(name) == 0) error_json("Location name cannot be empty.");
            else if (map_data.nodes >= MAX) error_json("Map is full.");
            else if (findLocation(&map_data, name) >= 0) error_json("Location already exists.");
            else { addLocation(&map_data, name); fputs("{\"ok\":true}\n", stdout); }
        } else if (!strcmp(command, "addRoad")) {
            if (!json_get_string(line, "from", from, sizeof(from)) ||
                !json_get_string(line, "to", to, sizeof(to)) ||
                !json_get_int(line, "cost", &cost)) error_json("addRoad requires from, to and integer cost.");
            else if ((u = findLocation(&map_data, from)) < 0 ||
                     (v = findLocation(&map_data, to)) < 0) error_json("Invalid location name.");
            else if (u == v) error_json("A location cannot have a road to itself.");
            else if (cost <= 0 || cost >= INF) error_json("Road cost must be between 1 and 9998.");
            else { addRoad(&map_data, from, to, cost); fputs("{\"ok\":true}\n", stdout); }
        } else if (!strcmp(command, "blockRoad") || !strcmp(command, "unblockRoad")) {
            int should_block = !strcmp(command, "blockRoad");
            if (!json_get_string(line, "from", from, sizeof(from)) ||
                !json_get_string(line, "to", to, sizeof(to))) error_json("Road command requires from and to.");
            else if ((u = findLocation(&map_data, from)) < 0 ||
                     (v = findLocation(&map_data, to)) < 0) error_json("Invalid location name.");
            else if (map_data.graph[u][v] == INF) error_json("No direct road exists between these locations.");
            else {
                if (should_block) blockRoad(&map_data, from, to);
                else map_data.blocked[u][v] = map_data.blocked[v][u] = 0;
                fputs("{\"ok\":true}\n", stdout);
            }
        } else if (!strcmp(command, "displayMap")) {
            handle_map();
        } else if (!strcmp(command, "findRoute")) {
            if (!json_get_string(line, "source", source, sizeof(source)) ||
                !json_get_string(line, "destination", destination, sizeof(destination)))
                error_json("findRoute requires source and destination.");
            else handle_route(source, destination);
        } else if (!strcmp(command, "exit")) {
            fputs("{\"ok\":true}\n", stdout); break;
        } else error_json("Unknown command.");
        fflush(stdout);
    }
    return 0;
}
