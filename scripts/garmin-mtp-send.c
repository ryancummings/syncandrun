#include <libmtp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static LIBMTP_folder_t *find_named_folder(LIBMTP_folder_t *folder, const char *name) {
    for (LIBMTP_folder_t *current = folder; current != NULL; current = current->sibling) {
        if (current->name != NULL && strcmp(current->name, name) == 0) {
            return current;
        }
    }
    return NULL;
}

static const char *basename_of(const char *path) {
    const char *slash = strrchr(path, '/');
    return slash == NULL ? path : slash + 1;
}

int main(int argc, char **argv) {
    if (argc < 2 || argc > 3) {
        fprintf(stderr, "usage: %s source.prg [remote-name.PRG]\n", argv[0]);
        return 2;
    }

    struct stat source_stat;
    if (stat(argv[1], &source_stat) != 0) {
        perror(argv[1]);
        return 3;
    }

    const char *remote_name = argc == 3 ? argv[2] : basename_of(argv[1]);
    if (remote_name[0] == '\0' || strchr(remote_name, '/') != NULL) {
        fprintf(stderr, "remote name must be one filename, not a path\n");
        return 3;
    }

    LIBMTP_Init();
    LIBMTP_mtpdevice_t *device = LIBMTP_Get_First_Device();
    if (device == NULL) {
        fprintf(stderr, "no MTP device found\n");
        return 4;
    }

    char *model = LIBMTP_Get_Modelname(device);
    if (model == NULL || strncmp(model, "Forerunner 955", strlen("Forerunner 955")) != 0) {
        fprintf(stderr, "refusing non-Forerunner-955 MTP device: %s\n", model == NULL ? "unknown" : model);
        free(model);
        LIBMTP_Release_Device(device);
        return 5;
    }

    LIBMTP_folder_t *folders = LIBMTP_Get_Folder_List(device);
    LIBMTP_folder_t *garmin = find_named_folder(folders, "GARMIN");
    LIBMTP_folder_t *apps = garmin == NULL ? NULL : find_named_folder(garmin->child, "Apps");
    if (apps == NULL) {
        fprintf(stderr, "GARMIN/Apps was not found on the connected MTP device\n");
        free(model);
        if (folders != NULL) LIBMTP_destroy_folder_t(folders);
        LIBMTP_Release_Device(device);
        return 6;
    }

    LIBMTP_file_t *file = LIBMTP_new_file_t();
    file->parent_id = apps->folder_id;
    file->storage_id = apps->storage_id;
    file->filename = strdup(remote_name);
    file->filesize = (uint64_t)source_stat.st_size;
    file->filetype = LIBMTP_FILETYPE_UNKNOWN;

    int result = LIBMTP_Send_File_From_File(device, argv[1], file, NULL, NULL);
    if (result != 0) {
        LIBMTP_Dump_Errorstack(device);
    } else {
        printf(
            "object-id=%u parent-id=%u storage-id=0x%08x bytes=%llu name=%s\n",
            file->item_id,
            file->parent_id,
            file->storage_id,
            (unsigned long long)file->filesize,
            file->filename
        );
    }

    free(model);
    LIBMTP_destroy_file_t(file);
    LIBMTP_destroy_folder_t(folders);
    LIBMTP_Release_Device(device);
    return result == 0 ? 0 : 7;
}
