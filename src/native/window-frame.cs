// Windows compositor frames: the target application is never asked to redraw.
namespace ChatBubbleCapture {
  using System;
  using System.Diagnostics;
  using System.Runtime.InteropServices;
  using System.Runtime.InteropServices.WindowsRuntime;
  using System.Threading;
  using Windows.Foundation;
  using Windows.Graphics.Capture;
  using Windows.Graphics.DirectX;
  using Windows.Graphics.DirectX.Direct3D11;
  using Windows.Graphics.Imaging;
  using Windows.Storage.Streams;

  [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ICaptureItemInterop {
    [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
    [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr item);
  }
  public static class WindowFrame {
    [DllImport("d3d11.dll", ExactSpelling=true)]
    static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr featureLevels, uint levelCount, uint sdkVersion, out IntPtr device, out uint featureLevel, out IntPtr context);
    [DllImport("d3d11.dll", ExactSpelling=true)]
    static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr device);

    public static string BackendName() { return "Windows.Graphics.Capture"; }
    static T Wait<T>(IAsyncOperation<T> operation, Stopwatch clock) {
      try {
        while(operation.Status==AsyncStatus.Started) {
          if(clock.ElapsedMilliseconds>1200) { operation.Cancel(); throw new TimeoutException(); }
          Thread.Sleep(3);
        }
        return operation.GetResults();
      } finally { if(operation.Status!=AsyncStatus.Started) operation.Close(); }
    }
    static void Wait(IAsyncAction operation, Stopwatch clock) {
      try {
        while(operation.Status==AsyncStatus.Started) {
          if(clock.ElapsedMilliseconds>1200) { operation.Cancel(); throw new TimeoutException(); }
          Thread.Sleep(3);
        }
        operation.GetResults();
      } finally { if(operation.Status!=AsyncStatus.Started) operation.Close(); }
    }
    static IDirect3DDevice CreateDevice() {
      IntPtr device=IntPtr.Zero, context=IntPtr.Zero, dxgi=IntPtr.Zero, projected=IntPtr.Zero; uint level;
      try {
        Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero,1,IntPtr.Zero,0x20,IntPtr.Zero,0,7,out device,out level,out context));
        Guid iid=new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device,ref iid,out dxgi));
        Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi,out projected));
        return (IDirect3DDevice)Marshal.GetObjectForIUnknown(projected);
      } finally {
        if(projected!=IntPtr.Zero) Marshal.Release(projected);
        if(dxgi!=IntPtr.Zero) Marshal.Release(dxgi);
        if(context!=IntPtr.Zero) Marshal.Release(context);
        if(device!=IntPtr.Zero) Marshal.Release(device);
      }
    }
    static GraphicsCaptureItem CreateItem(IntPtr handle, bool monitor) {
      object factory=WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
      ICaptureItemInterop interop=(ICaptureItemInterop)factory;
      Guid iid=new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
      IntPtr item=IntPtr.Zero;
      try {
        int result=monitor ? interop.CreateForMonitor(handle,ref iid,out item) : interop.CreateForWindow(handle,ref iid,out item);
        Marshal.ThrowExceptionForHR(result);
        return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(item);
      } finally { if(item!=IntPtr.Zero) Marshal.Release(item); }
    }
    static SoftwareBitmap TakeFrame(IDirect3DDevice device, GraphicsCaptureItem item, Stopwatch clock) {
      using(Direct3D11CaptureFramePool pool=Direct3D11CaptureFramePool.CreateFreeThreaded(device,DirectXPixelFormat.B8G8R8A8UIntNormalized,1,item.Size))
      using(GraphicsCaptureSession session=pool.CreateCaptureSession(item)) {
        session.IsCursorCaptureEnabled=false;
        session.StartCapture();
        while(clock.ElapsedMilliseconds<650) {
          using(Direct3D11CaptureFrame frame=pool.TryGetNextFrame()) {
            if(frame!=null) {
              if(frame.ContentSize.Width!=item.Size.Width || frame.ContentSize.Height!=item.Size.Height) throw new InvalidOperationException("size-changed");
              // Copy one frame to CPU memory, then release the session before PNG encoding.
              return Wait(SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface),clock);
            }
          }
          Thread.Sleep(5);
        }
        throw new TimeoutException();
      }
    }
    static byte[] Encode(SoftwareBitmap bitmap, Stopwatch clock) {
      using(InMemoryRandomAccessStream stream=new InMemoryRandomAccessStream()) {
        BitmapEncoder encoder=Wait(BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId,stream),clock);
        encoder.SetSoftwareBitmap(bitmap);
        double scale=Math.Min(1.0,1920.0/Math.Max(bitmap.PixelWidth,bitmap.PixelHeight));
        encoder.BitmapTransform.ScaledWidth=(uint)Math.Max(1,(int)(bitmap.PixelWidth*scale));
        encoder.BitmapTransform.ScaledHeight=(uint)Math.Max(1,(int)(bitmap.PixelHeight*scale));
        Wait(encoder.FlushAsync(),clock);
        if(stream.Size<80 || stream.Size>16000000) throw new InvalidOperationException("image-size");
        stream.Seek(0);
        using(DataReader reader=new DataReader(stream)) {
          Wait(reader.LoadAsync((uint)stream.Size),clock);
          byte[] data=new byte[(int)stream.Size]; reader.ReadBytes(data); return data;
        }
      }
    }
    public static string Capture(long handle, uint pid) { return CaptureTarget(handle,pid,false); }
    public static string CaptureMonitor(long handle) { return CaptureTarget(handle,0,true); }
    static string CaptureTarget(long handle, uint pid, bool monitor) {
      try {
        if(monitor ? !ChatBubbleTarget.ValidateMonitor(handle) : !ChatBubbleTarget.Validate(handle,pid)) return "{\"error\":\"window-unavailable\"}";
        if(!GraphicsCaptureSession.IsSupported()) return "{\"error\":\"capture-unsupported\"}";
        Stopwatch clock=Stopwatch.StartNew();
        GraphicsCaptureItem item=CreateItem(new IntPtr(handle),monitor);
        if(item.Size.Width<=0 || item.Size.Height<=0 || (long)item.Size.Width*item.Size.Height>16000000) return "{\"error\":\"image-invalid\"}";
        using(IDirect3DDevice device=CreateDevice())
        using(SoftwareBitmap bitmap=TakeFrame(device,item,clock)) {
          if(monitor ? !ChatBubbleTarget.ValidateMonitor(handle) : !ChatBubbleTarget.Validate(handle,pid)) return "{\"error\":\"window-unavailable\"}";
          byte[] bytes=Encode(bitmap,clock);
          return "{\"image\":\""+Convert.ToBase64String(bytes)+"\"}";
        }
      } catch(TimeoutException) { return "{\"error\":\"capture-timeout\"}"; }
      catch(Exception error) { return "{\"error\":\"capture-unsupported\",\"diagnostic\":\""+error.GetType().Name+"\"}"; }
    }
  }
}
