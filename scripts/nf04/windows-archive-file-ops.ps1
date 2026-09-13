param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('publish', 'delete')]
  [string] $Operation,

  [Parameter(Mandatory = $true)]
  [string] $RootPath,

  [Parameter(Mandatory = $true)]
  [string] $ParentPath,

  [Parameter(Mandatory = $true)]
  [string] $SourcePath,

  [string] $TargetName = '',

  [Parameter(Mandatory = $true)]
  [string] $ExpectedRootDevice,

  [Parameter(Mandatory = $true)]
  [string] $ExpectedRootInode,

  [Parameter(Mandatory = $true)]
  [string] $ExpectedParentDevice,

  [Parameter(Mandatory = $true)]
  [string] $ExpectedParentInode,

  [Parameter(Mandatory = $true)]
  [string] $ExpectedSourceDevice,

  [Parameter(Mandatory = $true)]
  [string] $ExpectedSourceInode
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$nativeSource = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace MentalHealth.Nf04
{
    public sealed class TargetExistsException : Exception
    {
        public TargetExistsException() : base("The publication target already exists") { }
    }

    public sealed class WindowsArchiveFileOperation : IDisposable
    {
        private const uint FILE_LIST_DIRECTORY = 0x0001;
        private const uint FILE_ADD_FILE = 0x0002;
        private const uint FILE_TRAVERSE = 0x0020;
        private const uint FILE_READ_ATTRIBUTES = 0x0080;
        private const uint DELETE = 0x00010000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint DRIVE_FIXED = 3;
        private const int FileRenameInformation = 10;
        private const int FileDispositionInfoEx = 21;
        private const uint FILE_DISPOSITION_FLAG_DELETE = 0x00000001;
        private const uint FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 0x00000002;
        private const int ERROR_FILE_EXISTS = 80;
        private const int ERROR_ALREADY_EXISTS = 183;

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint Low;
            public uint High;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint FileAttributes;
            public FILETIME CreationTime;
            public FILETIME LastAccessTime;
            public FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_STATUS_BLOCK
        {
            public IntPtr Status;
            public IntPtr Information;
        }

        private sealed class Identity
        {
            public ulong Device;
            public ulong Inode;
            public uint Attributes;
            public uint NumberOfLinks;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle file,
            int informationClass,
            IntPtr information,
            uint bufferSize);

        [DllImport("ntdll.dll")]
        private static extern int NtSetInformationFile(
            SafeFileHandle file,
            out IO_STATUS_BLOCK ioStatusBlock,
            IntPtr information,
            uint bufferSize,
            int informationClass);

        [DllImport("ntdll.dll")]
        private static extern uint RtlNtStatusToDosError(int status);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern uint GetDriveTypeW(string rootPathName);

        private readonly SafeFileHandle rootHandle;
        private readonly SafeFileHandle parentHandle;
        private readonly SafeFileHandle sourceHandle;
        private readonly string rootPath;
        private readonly string parentPath;
        private readonly string sourcePath;
        private readonly Identity sourceIdentity;
        private bool disposed;

        private WindowsArchiveFileOperation(
            SafeFileHandle rootHandle,
            SafeFileHandle parentHandle,
            SafeFileHandle sourceHandle,
            string rootPath,
            string parentPath,
            string sourcePath,
            Identity sourceIdentity)
        {
            this.rootHandle = rootHandle;
            this.parentHandle = parentHandle;
            this.sourceHandle = sourceHandle;
            this.rootPath = rootPath;
            this.parentPath = parentPath;
            this.sourcePath = sourcePath;
            this.sourceIdentity = sourceIdentity;
        }

        public static WindowsArchiveFileOperation Prepare(
            string rootPath,
            string parentPath,
            string sourcePath,
            ulong expectedRootDevice,
            ulong expectedRootInode,
            ulong expectedParentDevice,
            ulong expectedParentInode,
            ulong expectedSourceDevice,
            ulong expectedSourceInode)
        {
            string fullRoot = Path.GetFullPath(rootPath);
            string fullParent = Path.GetFullPath(parentPath);
            string fullSource = Path.GetFullPath(sourcePath);
            if (fullRoot.StartsWith(@"\\", StringComparison.Ordinal) ||
                !String.Equals(fullRoot, fullParent, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Path.GetDirectoryName(fullSource), fullParent, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("The filesystem boundary is unsupported");
            }

            string driveRoot = Path.GetPathRoot(fullRoot);
            if (String.IsNullOrEmpty(driveRoot) || GetDriveTypeW(driveRoot) != DRIVE_FIXED)
            {
                throw new InvalidOperationException("The archive volume is not a local fixed volume");
            }

            SafeFileHandle root = null;
            SafeFileHandle parent = null;
            SafeFileHandle source = null;
            try
            {
                root = OpenDirectory(fullRoot);
                parent = OpenDirectory(fullParent);
                source = OpenFileForMutation(fullSource);
                Identity rootIdentity = ReadIdentity(root);
                Identity parentIdentity = ReadIdentity(parent);
                Identity sourceIdentity = ReadIdentity(source);

                RequireDirectory(rootIdentity);
                RequireDirectory(parentIdentity);
                RequireRegularFile(sourceIdentity);
                RequireIdentity(rootIdentity, expectedRootDevice, expectedRootInode);
                RequireIdentity(parentIdentity, expectedParentDevice, expectedParentInode);
                RequireIdentity(sourceIdentity, expectedSourceDevice, expectedSourceInode);
                if (rootIdentity.Device != parentIdentity.Device || rootIdentity.Device != sourceIdentity.Device)
                {
                    throw new InvalidOperationException("The archive objects are not on one volume");
                }

                return new WindowsArchiveFileOperation(
                    root,
                    parent,
                    source,
                    fullRoot,
                    fullParent,
                    fullSource,
                    sourceIdentity);
            }
            catch
            {
                if (source != null) source.Dispose();
                if (parent != null) parent.Dispose();
                if (root != null) root.Dispose();
                throw;
            }
        }

        public void RecheckPaths()
        {
            ThrowIfDisposed();
            using (SafeFileHandle currentRoot = OpenDirectory(rootPath))
            using (SafeFileHandle currentParent = OpenDirectory(parentPath))
            using (SafeFileHandle currentSource = OpenFileForMutation(sourcePath))
            {
                RequireSameIdentity(ReadIdentity(rootHandle), ReadIdentity(currentRoot));
                RequireSameIdentity(ReadIdentity(parentHandle), ReadIdentity(currentParent));
                RequireSameIdentity(sourceIdentity, ReadIdentity(currentSource));
            }
        }

        public void Publish(string targetName)
        {
            ThrowIfDisposed();
            if (String.IsNullOrWhiteSpace(targetName) ||
                !String.Equals(Path.GetFileName(targetName), targetName, StringComparison.Ordinal) ||
                targetName.IndexOf(':') >= 0)
            {
                throw new InvalidOperationException("The publication target name is invalid");
            }

            byte[] name = System.Text.Encoding.Unicode.GetBytes(targetName);
            int rootOffset = IntPtr.Size == 8 ? 8 : 4;
            int lengthOffset = rootOffset + IntPtr.Size;
            int nameOffset = lengthOffset + sizeof(uint);
            int bufferSize = checked(nameOffset + name.Length);
            IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
            try
            {
                Marshal.Copy(new byte[bufferSize], 0, buffer, bufferSize);
                Marshal.WriteByte(buffer, 0, 0);
                Marshal.WriteIntPtr(buffer, rootOffset, parentHandle.DangerousGetHandle());
                Marshal.WriteInt32(buffer, lengthOffset, name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
                IO_STATUS_BLOCK ioStatus;
                int status = NtSetInformationFile(
                    sourceHandle,
                    out ioStatus,
                    buffer,
                    (uint)bufferSize,
                    FileRenameInformation);
                if (status < 0)
                {
                    int error = unchecked((int)RtlNtStatusToDosError(status));
                    if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS)
                    {
                        throw new TargetExistsException();
                    }
                    throw new Win32Exception(error);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            string finalPath = Path.Combine(parentPath, targetName);
            using (SafeFileHandle published = OpenFileForRead(finalPath))
            {
                RequireRegularFile(ReadIdentity(published));
                RequireSameIdentity(sourceIdentity, ReadIdentity(published));
            }
            if (File.Exists(sourcePath) || Directory.Exists(sourcePath))
            {
                throw new InvalidOperationException("The partial archive name still exists");
            }
        }

        public void Delete()
        {
            ThrowIfDisposed();
            IntPtr buffer = Marshal.AllocHGlobal(sizeof(uint));
            try
            {
                Marshal.WriteInt32(
                    buffer,
                    unchecked((int)(FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS)));
                if (!SetFileInformationByHandle(sourceHandle, FileDispositionInfoEx, buffer, sizeof(uint)))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public static void RequireAbsent(string path)
        {
            string fullPath = Path.GetFullPath(path);
            if (File.Exists(fullPath) || Directory.Exists(fullPath))
            {
                throw new InvalidOperationException("The exact file deletion could not be confirmed");
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            sourceHandle.Dispose();
            parentHandle.Dispose();
            rootHandle.Dispose();
        }

        private static SafeFileHandle OpenDirectory(string path)
        {
            return OpenChecked(
                path,
                FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        }

        private static SafeFileHandle OpenFileForMutation(string path)
        {
            return OpenChecked(path, DELETE | FILE_READ_ATTRIBUTES, FILE_FLAG_OPEN_REPARSE_POINT);
        }

        private static SafeFileHandle OpenFileForRead(string path)
        {
            return OpenChecked(path, FILE_READ_ATTRIBUTES, FILE_FLAG_OPEN_REPARSE_POINT);
        }

        private static SafeFileHandle OpenChecked(string path, uint access, uint flags)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero,
                OPEN_EXISTING,
                flags,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error);
            }
            return handle;
        }

        private static Identity ReadIdentity(SafeFileHandle handle)
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return new Identity
            {
                Device = information.VolumeSerialNumber,
                Inode = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow,
                Attributes = information.FileAttributes,
                NumberOfLinks = information.NumberOfLinks
            };
        }

        private static void RequireDirectory(Identity identity)
        {
            if ((identity.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                (identity.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
            {
                throw new InvalidOperationException("A protected directory is invalid");
            }
        }

        private static void RequireRegularFile(Identity identity)
        {
            if ((identity.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                (identity.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
                identity.NumberOfLinks != 1)
            {
                throw new InvalidOperationException("A protected file is invalid");
            }
        }

        private static void RequireIdentity(Identity actual, ulong device, ulong inode)
        {
            if (actual.Device != device || actual.Inode != inode)
            {
                throw new InvalidOperationException("A protected filesystem identity changed");
            }
        }

        private static void RequireSameIdentity(Identity expected, Identity actual)
        {
            RequireIdentity(actual, expected.Device, expected.Inode);
        }

        private void ThrowIfDisposed()
        {
            if (disposed) throw new ObjectDisposedException("WindowsArchiveFileOperation");
        }
    }
}
'@

function Write-Nf04Result {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('completed', 'rejected', 'unknown')]
    [string] $Status,

    [Parameter(Mandatory = $true)]
    [string] $Code
  )

  $result = [ordered]@{
    version = 1
    status = $Status
    code = $Code
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

$context = $null
$dispatched = $false
try {
  $null = Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
  $culture = [System.Globalization.CultureInfo]::InvariantCulture
  $context = [MentalHealth.Nf04.WindowsArchiveFileOperation]::Prepare(
    $RootPath,
    $ParentPath,
    $SourcePath,
    [UInt64]::Parse($ExpectedRootDevice, $culture),
    [UInt64]::Parse($ExpectedRootInode, $culture),
    [UInt64]::Parse($ExpectedParentDevice, $culture),
    [UInt64]::Parse($ExpectedParentInode, $culture),
    [UInt64]::Parse($ExpectedSourceDevice, $culture),
    [UInt64]::Parse($ExpectedSourceInode, $culture)
  )
  $context.RecheckPaths()
  $dispatched = $true

  if ($Operation -eq 'publish') {
    $context.Publish($TargetName)
  } else {
    $context.Delete()
    $context.Dispose()
    $context = $null
    [MentalHealth.Nf04.WindowsArchiveFileOperation]::RequireAbsent($SourcePath)
  }

  Write-Nf04Result -Status 'completed' -Code 'COMPLETED'
  exit 0
} catch [MentalHealth.Nf04.TargetExistsException] {
  Write-Nf04Result -Status 'rejected' -Code 'TARGET_EXISTS'
  exit 0
} catch {
  if ($dispatched) {
    Write-Nf04Result -Status 'unknown' -Code 'MUTATION_UNKNOWN'
  } else {
    Write-Nf04Result -Status 'rejected' -Code 'BOUNDARY_REJECTED'
  }
  exit 0
} finally {
  if ($null -ne $context) {
    $context.Dispose()
  }
}
