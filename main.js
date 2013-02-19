/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, $, brackets, window */

/** extension to generate & validate cache manifest files */
define(function (require, exports, module) {

    'use strict';

    var dropboxlib              = require("dropbox"),
        dpOpenFolderDialogHtml  = require("text!htmlContent/dp-open-folder-dialog.html");

    var CommandManager      = brackets.getModule("command/CommandManager"),
        ProjectManager      = brackets.getModule("project/ProjectManager"),
        DocumentManager     = brackets.getModule("document/DocumentManager"),
        EditorManager       = brackets.getModule("editor/EditorManager"),
        NativeFileSystem    = brackets.getModule("file/NativeFileSystem").NativeFileSystem,
        FileUtils           = brackets.getModule("file/FileUtils"),
        ExtensionUtils      = brackets.getModule("utils/ExtensionUtils"),
        Dialogs             = brackets.getModule("widgets/Dialogs"),
        Commands            = brackets.getModule("command/Commands"),
        LiveDevelopment     = brackets.getModule("LiveDevelopment/LiveDevelopment"),
        Menus               = brackets.getModule("command/Menus");

    var DROPBOX_MENU = "dropbox-menu",
        DROPBOX_MENU_NAME = "Dropbox",
        AUTH_COMMAND_ID = "dropbox.authorize",
        AUTH_MENU_NAME = "Authorize",
        OPEN_COMMAND_ID = "dropbox.open",
        OPEN_MENU_NAME = "Open Dropbox Folder...",
        SAVE_COMMAND_ID = "dropbox.save",
        SAVE_MENU_NAME = "Save",
        PROJECTS_TEMP_FOLDER = "brackets-projects";

    var dropboxFiles,
        dropboxFolder,
        moduleDir;

    function _getDropboxProjectFolder(folderName, callback) {
        var getTempRootDirectory = function(callback) {
            if (os) {
                callback(new NativeFileSystem.DirectoryEntry(os.tmpDir()));
            }
            else {
                window.BlobBuilder = window.BlobBuilder || window.MozBlobBuilder || window.WebKitBlobBuilder;
                window.requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem;
                requestFileSystem(window.TEMPORARY, 20*1024*1024, function(filesystem) {
                    callback(filesystem.root);
                })
            }
        }
        getTempRootDirectory(function (rootEntry) {
            rootEntry.getDirectory(PROJECTS_TEMP_FOLDER,{create:true},  function (dirEntry) {
                dirEntry.getDirectory(folderName, {create:true}, callback);
            })
        })
    }
    function showMessage(msg) {
        Dialogs.showModalDialog(Dialogs.DIALOG_ID_ERROR, "Dropbox Extension", msg);
    }

    /**
     * Open a dialog to select a Dropbox folder
     */
    function selectDropboxFolder() {
        getDropbox(function (error, client) {
            if (error) {
                showMessage('Authentication error: ' + error);
            }
            client.getUserInfo(function(error, userInfo) {
                if (error) {
                    showMessage(error);
                }
                $('.dropbox-user').html('Dropbox user: ' + userInfo.name);
            });
            readDropboxFolder(dropbox, "/");
            Dialogs.showModalDialog("dp-open-folder-dialog").done(function (id) {
                if (id === 'open') {
                    createProjectFiles();
                }
            });
        });
    }

    /**
     * Iterate through the files in the selected Dropbox folder. For each Dropbox file, we create a file in the
     * current Brackets project. The files will be Lazy loaded from Dropbox (they will only be loaded when selected
     * in the project tree)
     */
    function createProjectFiles() {
        var len  = dropboxFiles.length;
        _getDropboxProjectFolder(dropboxFolder.substr(1), function (dirEntry) {
            for (var i=0; i<len; i++) {
                createProjectFile(dirEntry, dropboxFiles[i]);
            }
        }, onError);
        ProjectManager.openProject("dropbox://" + dropboxFolder);
    }

    /**
     * Create a new file and add it to the project.
     * @param file
     * @return {*}
     */
    function _writeFile (dirEntry, fileName, contents) {
        dirEntry.getFile(fileName, {create:true}, function (fileEntry) {
            console.log("Created file:", fileEntry);
            fileEntry.createWriter(function (fileWriter) {
                var bb, ab, ia;

                fileWriter.onwriteend = function (progressEvent) {
                    console.log("File written:" , fileEntry.toURL());
                };
                fileWriter.onerror = onError;
                ab = new ArrayBuffer(contents.length);
                ia = new Uint8Array(ab);
                for (var i = 0; i < contents.length; i++) {
                    ia[i] = contents.charCodeAt(i);
                }
                if (window.Buffer)
                    bb = new Buffer(ia);
                else {
                    try {
                        bb = new Blob([contents]);
                    } catch(e) {
                        if (window.BlobBuilder){
                            bb = new BlobBuilder(); // Create a new Blob on-the-fly.
                            bb.append(contents);
                            bb = bb.getBlob();
                        } else {
                            console.error("No Blob or BlobBuilder constructor.");
                            return;
                        }
                    }
                }
                bb && fileWriter.write(bb);

            }, onError);
        })
    }
    function createProjectFile(dirEntry, file) {
        console.log("creating " + file.name);
        readDropboxFile(dropboxFolder + "/" + file.name).done(function(contents) {
            _writeFile(dirEntry, file.name, contents);
        })
    }

    /**
     * Read the selected file from Dropbox, if it hasn't already been loaded.
     */
    function documentChangeHandler() {
        var doc = DocumentManager.getCurrentDocument();
        console.log("documentChangeHandler: " + doc.file.name);
        if (doc.getText() === "") {
            readDropboxFile(dropboxFolder + "/" + doc.file.name).done(function(content) {
                doc.setText(content);
            });
        }
    }

    /*
     * Read the text content of a Dropbox file
     */
    function readDropboxFile(path) {
        var deferred = $.Deferred();
        dropbox.readFile(path, {binary: true},   function(error, data) {
            if (error) {
                deferred.reject(error);  // Something went wrong.
            }
            deferred.resolve(data);
        });
        return deferred;
    }

    function saveDropboxFile() {
        var doc = DocumentManager.getCurrentDocument();
        dropbox.writeFile(dropboxFolder + "/" + doc.file.name, doc.getText(), function(error, stat) {
            if (error) {
                showMessage(error);  // Something went wrong.
            }
            showMessage("File " + doc.file.name + " saved");
        });
    }

    /**
     * Authorize via Dropbox OAuth
     */
    function authorize() {

        dropbox.authenticate(function (error, client) {
            if (error) {
                showMessage('Authentication error: ' + error);
            }
            client.getUserInfo(function(error, userInfo) {
                if (error) {
                    showMessage(error);
                }
                $('.dropbox-user').html('Dropbox user: ' + userInfo.name);
            });
        });
    }

    function onError (err) {
         var msg = 'Error: ';
         switch (err.code) {
             case FileError.NOT_FOUND_ERR:
                 msg += 'File or directory not found';
                 break;
             case FileError.SECURITY_ERR:
                 msg += 'Insecure or disallowed operation';
                 break;
             case FileError.ABORT_ERR:
                 msg += 'Operation aborted';
                 break;
             case FileError.NOT_READABLE_ERR:
                 msg += 'File or directory not readable';
                 break;
             case FileError.ENCODING_ERR:
                 msg += 'Invalid encoding';
                 break;
             case FileError.NO_MODIFICATION_ALLOWED_ERR:
                 msg += 'Cannot modify file or directory';
                 break;
             case FileError.INVALID_STATE_ERR:
                 msg += 'Invalid state';
                 break;
             case FileError.SYNTAX_ERR:
                 msg += 'Invalid line-ending specifier';
                 break;
             case FileError.INVALID_MODIFICATION_ERR:
                 msg += 'Invalid modification';
                 break;
             case FileError.QUOTA_EXCEEDED_ERR:
                 msg += 'Storage quota exceeded';
                 break;
             case FileError.TYPE_MISMATCH_ERR:
                 msg += 'Invalid filetype';
                 break;
             case FileError.PATH_EXISTS_ERR:
                 msg += 'File or directory already exists at specified path';
                 break;
             default:
                 msg += 'Unknown Error';
                 break;
         }
         console.warn(msg);
    }
    /**
     * Read content of Dropbox folder and populate the Open Folder dialog with the list of files
     * @param dropbox
     * @param path
     * @param callback
     */
    function readDropboxFolder(dropbox, path) {
        dropboxFolder = path;
        console.log("Dropbox Folder: " + dropboxFolder);
        displayPath(path);
        $('.dropbox-file-rows').empty();
        dropbox.readdir(path, function(error, fileNames, folder, files) {
            if (error) {
                alert('Error: ' + error);
                return;
            }
            dropboxFiles = files;
            var len = files.length;
            var file;
            console.log('readdir len:' + len);
            console.log($('#dpRows'));
            for (var i = 0; i<len ; i++) {
                file = files[i];
                console.log(moduleDir + '/img/' +  (file.isFile ? "file" : "folder" ) + '.png');
                $('.dropbox-file-rows').append(
                    '<tr data-path=' + file.path + (file.isFolder ? ' class="folder-row"' : '') + '><td class="file-icon">' +
                    '<img src="' + moduleDir + '/img/' +  (file.isFile ? "file" : "folder" ) + '.png"/> ' +
                    "</td><td>" +
                    file.name +
                    "</td><td>" +
                    file.humanSize +
                    "</td><td>" +
                    file.modifiedAt +
                    '</td></tr>');
            }
        });
    }

    /**
     * Display bread crumbs for the path in the Open Folder dialog
     * @param path
     */
    function displayPath(path) {
        var arr = path.split("/");
        var len  = arr.length;
        if (arr[len - 1] == "") {
            arr.pop();
            len = len - 1;
        }
        var html = "";
        var fullPath = "";
        for (var i=0; i<len; i++) {
            var fullPath = fullPath + arr[i] + '/';
            html = html +
                (i==0 ? "" : " / ") + '<a href="#" class="dropbox-path-link" data-path="' + fullPath + '">' + ( i==0 ? 'root' : arr[i] ) + '</a>';
        }
        $('.dropbox-path').html(html);
    }


    function initialize() {

        ExtensionUtils.loadStyleSheet(module, "css/dropbox.css");

        $('body').append($(Mustache.render(dpOpenFolderDialogHtml)));

        // Register commands
        CommandManager.register(OPEN_MENU_NAME, OPEN_COMMAND_ID, selectDropboxFolder);

        // Add menus
        var fileMenu = Menus.getMenu(Menus.AppMenuBar.FILE_MENU);
        fileMenu.addMenuItem(OPEN_COMMAND_ID, "", Menus.AFTER,
                Commands.FILE_OPEN_FOLDER);

        $('body').on('mouseover', '.folder-row', function(event) {
            $(event.currentTarget).addClass('highlight');
        });

        $('body').on('mouseout', '.folder-row', function(event) {
            $(event.currentTarget).removeClass('highlight');
        });

        $('body').on('click', '.folder-row', function(event) {
            readDropboxFolder(dropbox, $(event.currentTarget).data('path'));
        });

        $('body').on('click', '.dropbox-path-link', function(event) {
            event.stopImmediatePropagation();
            event.preventDefault();
            readDropboxFolder(dropbox, $(event.currentTarget).data('path'));
        });
        $('body').on('click','#new-dropbox-folder', function () {
            var newFolder= $("<td><input/></td>");
            var primaryButton = $('.dialog-button.primary');
            $('.dropbox-file-rows').append($('<tr><td class="file-icon">' +
                '<img src="' + moduleDir + '/img/folder.png"/> ' +
                "</td>" +
                '</tr>').append(newFolder).append('<td/>').append('<td/>'));
            newFolder.find('input').val("Untitled").focus(function () {
                primaryButton.removeClass('primary');
            }).focus().bind("blur keydown", function (e) {
                var code = (e.keyCode ? e.keyCode : e.which);
                if (code && code !== 13)
                    return;
                primaryButton.addClass('primary');
                brackets.fs.makedir("dropbox://" + dropboxFolder + "/" + $(this).val(), null,  function () {
                    readDropboxFolder(dropbox, dropboxFolder);
                });
            });


        });
        $('body').on('click','#delete-dropbox-folder', function () {
            dropbox.remove(dropboxFolder, function (){
                readDropboxFolder(dropbox, $(".dropbox-path-link").last().prev().data('path'));
            });
        });

        moduleDir = FileUtils.getNativeModuleDirectoryPath(module);
    }

    LiveDevelopment.addUrlMapper(function (url) {
        if (os)
            url = url.replace(/file:\/\/dropbox:\/\/(.*)/, "file://" +
                os.tmpDir() +"/" + PROJECTS_TEMP_FOLDER + "$1");
        else if (window.device === "Simulator")
            url = url.replace(/^.*dropbox:\/\/(.*)/, "filesystem:" +
                location.origin + "/temporary/" + PROJECTS_TEMP_FOLDER + "$1");
        return  url;
    })
    $(DocumentManager).on("documentSaved", function (event, doc) {
        var path = doc.file.fullPath;
        if (path.indexOf("dropbox://") === 0) {
            var folderName = path.replace("dropbox://", "");
            folderName = folderName.substr(0, folderName.lastIndexOf("/")).substr(1);
            _getDropboxProjectFolder(folderName, function (entry) {
                _writeFile(entry, doc.file.name, doc.getText(true));
            });
        }
    });


    initialize();

});