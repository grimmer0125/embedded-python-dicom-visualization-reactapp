import { useRef, useEffect, useState, useCallback } from "react";
import 'semantic-ui-css/semantic.min.css'

import {
  Dropdown,
  Checkbox,
  CheckboxProps,
  DropdownProps,
  Radio,
} from "semantic-ui-react";

import Hotkeys from "react-hot-keys";

import Slider from "rc-slider";
import "rc-slider/assets/index.css";

import { useDropzone } from "react-dropzone";
import { initPyodideAndLoadPydicom, loadPyodideDicomModule, loadDicomFileAsync, fetchDicomFileAsync } from "./pyodideHelper";
// import { PyProxyBuffer } from '../public/pyodide/pyodide.d'
import canvasRender from "./canvasRenderer"
import decompressJPEG from "./jpegDecoder"

type PyProxyBuffer = any
type PyProxyObj = any

const MAX_WIDTH_SINGLE_MODE = 1280;
const MAX_HEIGHT_SINGLE_MODE = 1024;
const MAX_WIDTH_SERIES_MODE = 400;
const MAX_HEIGHT_SERIES_MODE = 400;

const dropZoneStyle = {
  borderWidth: 2,
  borderColor: "#666",
  borderStyle: "dashed",
  borderRadius: 5,
  width: 800,
  height: 180,
};

enum SeriesMode {
  NoSeries,
  Series
}

enum NormalizationMode {
  Pixel_MaxMin_Mode, //start from 0 
  WindowCenter,
  // below are for CT,   // https://radiopaedia.org/articles/windowing-ct
  AbdomenSoftTissues, //W:400 L:50
  SpineSoftTissues, // W:250 L:50
  SpineBone, // W:1800 L:400
  Brain, // W:80 L:40
  Lungs, // W:1500 L:-600. chest
}

interface WindowItem {
  W: number;
  L: number;
}

interface NormalizationProps {
  disable?: boolean;
  mode: NormalizationMode;
  windowItem?: WindowItem;
  currNormalizeMode: NormalizationMode;
  onChange?: (
    e: React.FormEvent<HTMLInputElement>,
    data: CheckboxProps
  ) => void;
}

interface IWindowDictionary {
  [id: number]: WindowItem;
}

const WindowCenterWidthConst: IWindowDictionary = {
  [NormalizationMode.AbdomenSoftTissues]: {
    W: 400,
    L: 50,
  },
  [NormalizationMode.SpineSoftTissues]: {
    W: 250,
    L: 50,
  },
  [NormalizationMode.SpineBone]: {
    W: 1800,
    L: 400,
  },
  [NormalizationMode.Brain]: {
    W: 80,
    L: 40,
  },
  [NormalizationMode.Lungs]: {
    W: 1500,
    L: -600,
  },
};

function NormalizationComponent(props: NormalizationProps) {
  const { mode, windowItem, currNormalizeMode, onChange, disable } = props;
  const data = windowItem ?? WindowCenterWidthConst[mode] ?? null;
  return (
    <>
      <Checkbox
        radio
        disabled={disable}
        label={NormalizationMode[mode]}
        name="checkboxRadioGroup"
        value={mode}
        checked={currNormalizeMode === mode}
        onChange={onChange}
      // checked={ifWindowCenterMode}
      // onChange={this.handleNormalizeModeChange}
      />
      {data ? ` c:${data.L}, w:${data.W}  ` : `  `}
    </>
  );
}

function checkIfValidDicomFileName(name: string) {
  if (
    name.toLowerCase().endsWith(".dcm") === false &&
    name.toLowerCase().endsWith(".dicom") === false
  ) {
    // console.log("not dicom file:", name);
    return false;
  }
  return true;
}

// interface PyodideDicomObject {
//   SayHi: () => void
// }

let total = 0;

function App() {
  const myCanvasRef = useRef<HTMLCanvasElement>(null);
  const myCanvasRefSagittal = useRef<HTMLCanvasElement>(null);
  const myCanvasRefCorona = useRef<HTMLCanvasElement>(null);

  const isValidMouseDown = useRef(false);
  const clientX = useRef<number>()
  const clientY = useRef<number>()
  const dicomObj = useRef<any>(null);
  const PyodideDicom = useRef<Function>()
  const files = useRef<File[] | string[]>([]);

  const maxViewWidth = useRef<number>(MAX_WIDTH_SINGLE_MODE)
  const maxViewHeight = useRef<number>(MAX_HEIGHT_SINGLE_MODE)
  const currScale = useRef<number>(1)

  const [totalFiles, setTotalFiles] = useState<number>(0)
  const [totalCoronaFrames, setTotalCoronaFrames] = useState<number>(0)
  const [totalSagittalFrames, setTotalSagittalFrames] = useState<number>(0)
  const [currFileNo, setCurrFileNo] = useState<number>(0)
  const [currentSagittalNo, setCurrentSagittalNo] = useState<number>(0)
  const [currentCoronaNo, setCurrentCoronaNo] = useState<number>(0)

  const [ifShowSagittalCoronal, setIfShowSagittalCoronal] = useState<SeriesMode>(SeriesMode.NoSeries);
  const [isCommonAxialView, setIsCommonAxialView] = useState(false);

  // for testing 
  const fileBuffer = useRef<any>(null);

  const [isPyodideLoading, setPyodideLoading] = useState(true);
  const [modality, setModality] = useState("")
  const [photometric, setPhotometric] = useState("")
  const [transferSyntax, setTransferSyntax] = useState("")
  const [currFilePath, setCurrFilePath] = useState("")
  const [resX, setResX] = useState<number>()
  const [resY, setResY] = useState<number>()
  const [pixelMax, setPixelMax] = useState<number>()
  const [pixelMin, setPixelMin] = useState<number>()
  const [windowCenter, setWindowCenter] = useState<number>()
  const [windowWidth, setWindowWidth] = useState<number>()
  const [useWindowCenter, setUseWindowCenter] = useState<number>()
  const [useWindowWidth, setUseWindowWidth] = useState<number>()
  // todo: define a clear interface/type instead of any 
  const [currNormalizeMode, setCurrNormalizeMode] = useState<NormalizationMode>(NormalizationMode.WindowCenter)
  const [numFrames, setNumFrames] = useState<number>(1)
  const [currFrameIndex, setCurrFrameIndex] = useState<number>(1)


  const onMouseMove = (event: any) => {
    const isGrey = photometric === "MONOCHROME1" || photometric === "MONOCHROME2"
    // console.log("onMouseMove1:", isGrey, isValidMouseDown.current, clientX.current, clientY.current, pixelMax, pixelMin)
    if (isGrey && isValidMouseDown.current && clientX.current != undefined && clientY.current != undefined && pixelMax != undefined && pixelMin != undefined) {

      let deltaX = event.clientX - clientX.current;
      let deltaY = clientY.current - event.clientY;

      let newWindowWidth, newWindowCenter;

      let previousWindowWidth = useWindowWidth ?? windowWidth;
      if (previousWindowWidth) {
        newWindowWidth = previousWindowWidth + deltaX;
        if (newWindowWidth <= 1) {
          newWindowWidth = 2;
          deltaX = newWindowWidth - newWindowWidth;
        }
      } else {
        newWindowWidth = Math.floor((pixelMax - pixelMin) / 2);
      }

      if (deltaX === 0 && deltaY === 0) {
        // console.log(" delta x = y = 0")
        return;
      }

      let previousWindowCenter = useWindowCenter ?? windowCenter;
      if (previousWindowCenter) {
        newWindowCenter = previousWindowCenter + deltaY;
      } else {
        newWindowCenter = Math.floor((pixelMin + pixelMax) / 2);
      }

      setUseWindowCenter(newWindowCenter)
      setUseWindowWidth(newWindowWidth)

      if (ifShowSagittalCoronal === SeriesMode.Series) {
        const sag_ndarray = dicomObj.current.redner_sag_view.callKwargs({
          normalize_window_center: newWindowCenter, normalize_window_width: newWindowWidth
        });
        renderFrame({ sag_ndarray })
        const cor_ndarray = dicomObj.current.redner_cor_view.callKwargs({
          normalize_window_center: newWindowCenter, normalize_window_width: newWindowWidth
        });
        renderFrame({ cor_ndarray })
        const ax_ndarray = dicomObj.current.render_axial_view.callKwargs({
          normalize_window_center: newWindowCenter, normalize_window_width: newWindowWidth
        });
        renderFrame({ ax_ndarray })
      } else {
        const ndarray = dicomObj.current.render_frame_to_rgba_1d(newWindowCenter, newWindowWidth)
        renderFrame({ ndarray })
      }

      // processDicomBuffer(fileBuffer.current)
    } else {
      // console.log("not valid move")
    }
    clientX.current = event.clientX;
    clientY.current = event.clientY;
  }

  const onMouseCanvasDown = useCallback((event: any) => {
    // console.log("onMouseDown:", event, typeof event);

    clientX.current = event.clientX;
    clientY.current = event.clientY;
    isValidMouseDown.current = true;
    // window.addEventListener("mousemove", onMouseMove);
  }, []);

  const onMouseUp = useCallback((event: any) => {
    // console.log("onMouseUp:", event);
    isValidMouseDown.current = false;
    // window.removeEventListener("mousemove", onMouseMove);
  }, []);

  const onOpenFileURLs = (fileURLStr: string) => {
    const onlineFiles = fileURLStr.split("file://"); // https:// or file://xx + file://xx2
    onlineFiles.sort((a, b) => {
      return a.localeCompare(b);
    });
    console.log("sorted online files:", onlineFiles);

    const tmpFiles = []
    // case1:
    // e.g. chrome-extension://fpklmaeeoagikoaiakadencfmhodampd/index.html#https://raw.githubusercontent.com/grimmer0125/dicom-web-viewer/test/image-00000-ot.dcm
    // -> fileURLStr = "https://raw.githubusercontent.com/grimmer0125/dicom-web-viewer/test/image-00000-ot.dcm"
    // -> files = ["https://raw.githubusercontent.com/grimmer0125/dicom-web-viewer/test/image-00000-ot.dcm]
    // case2:
    // drag a local file. e.g. fileURLs.split("file://"); fileURLStr = "file://xxx.dcm"
    // files = ["", "/users/grimmer/downloads/dicom/image-00000-ot.dcm"]
    // this.files = [];
    if (onlineFiles.length === 1) {
      // case1
      tmpFiles.push(`${onlineFiles[0]}`);
    } else {
      // case2
      onlineFiles.forEach((file, index) => {
        if (index !== 0 || files.current.length === 1) {
          tmpFiles.push(`file://${file}`);
        }
      });
    }

    files.current = tmpFiles.filter((file: string) => {
      return checkIfValidDicomFileName(file);
    })

    if (files.current.length > 0) {
      renderFiles(files.current, ifShowSagittalCoronal)
    }
  }


  useEffect(() => {

    function checkOnlineFiles() {
      // window.addEventListener("mouseup", this.onMouseUp);
      // window.addEventListener("mouseup", this.onMouseUp);

      // get file path from current url, e.g.
      // chrome-extension://jfnlfimghfiagibfigmlopnfljpfnnje/dicom.html#file:///tmp/test.dcm
      const url = window.location.href;
      // 'http://localhost#http://medistim.com/wp-content/uploads/2016/07/ttfm.dcm'; //
      // console.log("current url:", url);

      if (
        url.toLowerCase().indexOf(".dcm") !== -1 ||
        url.toLowerCase().indexOf(".dicom") !== -1
      ) {
        // const paths = url.split("#");
        const firstHash = url.indexOf("#");
        if (firstHash > -1) {
          const fileURLs = url.substring(firstHash + 1, url.length);
          // const filePath = paths[1];
          // this.fetchFile(filePath);

          onOpenFileURLs(fileURLs);
        }
      }
    }

    async function init() {
      console.log("initialize Pyodide, python browser runtime");
      // todo: sometimes App will be reloaded due to CRA hot load and hrow exception due to 2nd load pyodide
      if (isPyodideLoading) {
        try {
          initPyodideAndLoadPydicom(); // do some initialization
          PyodideDicom.current = await loadPyodideDicomModule();
          setPyodideLoading(false);
          console.log("finish initializing Pyodide");
          checkOnlineFiles()
        } catch {
          console.log("init pyodide error, probably duplicate loading it");
        }
      }
    }
    init();
    // console.log("register mouseup")
    window.addEventListener("mouseup", onMouseUp);

  }, []); // [] means only 1 time, if no [], means every update this will be called


  const needScale = (width: number, height: number, maxWidth: number, maxHeight: number) => {
    let scale = 1;

    if (width <= maxWidth && height <= maxHeight) {
      return scale;
    }
    const scaleW = width / maxWidth;
    const scaleH = height / maxHeight;
    scale = scaleW >= scaleH ? scaleW : scaleH;

    return 1 / scale;
  }

  const renderFrame = ({ ndarray, ax_ndarray, sag_ndarray, cor_ndarray }: { ndarray?: PyProxyBuffer, ax_ndarray?: PyProxyBuffer, sag_ndarray?: PyProxyBuffer, cor_ndarray?: PyProxyBuffer }) => {
    // TODO: add parameters to specify which should be updated 
    const image: PyProxyObj = dicomObj.current;

    // todo: figure it out 
    // 1. x need destroy old (e.g. image.destroy()) when assign new image ? yes
    // 2. x how to get toJS(1) effect when assigning a python object instance to dicom.current?
    // 3. x /** TODO: need releasing pyBufferData? pyBufferData.release()
    // * ref: https://pyodide.org/en/stable/usage/type-conversions.html#converting-python-buffer-objects-to-javascript */
    // const render_rgba_1d_ndarray: any = image.render_rgba_1d_ndarray;
    // console.log("render_rgba_1d_ndarray:", render_rgba_1d_ndarray, typeof render_rgba_1d_ndarray)
    // const kk = image.toJs({ depth: 1 })
    // console.log("kk:", kk)

    if (ndarray) {
      // const ndarray_proxy = (image as any).get_rgba_1d_ndarray() //render_rgba_1d_ndarray
      const buffer = (ndarray as PyProxyBuffer).getBuffer("u8clamped");
      (ndarray as PyProxyBuffer).destroy();
      // console.log("pyBufferData data type1, ", typeof pyBufferData.data, pyBufferData.data) // Uint8ClampedArray
      const uncompressedData = buffer.data as Uint8ClampedArray
      // console.log("uncompressedData:", uncompressedData, uncompressedData.length, uncompressedData.byteLength)

      const scale = needScale(image.width, image.height, maxViewWidth.current, maxViewHeight.current)
      // console.log("need scale:", scale)
      currScale.current = scale
      canvasRender.renderUncompressedData(uncompressedData, image.width as number, image.height as number, myCanvasRef, undefined, undefined, scale);
      buffer.release(); // Release the memory when we're done
    } else {

      const ax_scale = needScale(image.series_dim_x, image.series_dim_y, maxViewWidth.current, maxViewHeight.current)
      const sag_scale = needScale(image.series_dim_y, image.series_dim_z * image.sag_aspect, maxViewWidth.current, maxViewHeight.current)
      const cor_scale = needScale(image.series_dim_x, image.series_dim_z * image.cor_aspect, maxViewWidth.current, maxViewHeight.current)
      const scale = Math.min(ax_scale, sag_scale, cor_scale)
      // console.log("need 3d scale:", scale)
      currScale.current = scale

      // const ndarray = (image as any).get_ax_ndarray()
      if (ax_ndarray) {
        // console.log("ax_ndarray")
        const buffer = ax_ndarray.getBuffer("u8clamped");
        ax_ndarray.destroy();
        const uncompressedData = buffer.data as Uint8ClampedArray
        // console.log("uncompressedData:", uncompressedData, uncompressedData.length, uncompressedData.byteLength)
        // console.log("w:", image.width, image.height)

        canvasRender.renderUncompressedData(uncompressedData, image.series_dim_x as number, image.series_dim_y as number, myCanvasRef, undefined, undefined, scale);
        buffer.release();
      }

      if (sag_ndarray) {
        // const shape = image.get_3d_shape().toJs();
        // console.log("sag_ndarray:", shape);

        const buffer = (sag_ndarray as PyProxyBuffer).getBuffer("u8clamped");
        (sag_ndarray as PyProxyBuffer).destroy();
        const uncompressedData = buffer.data as Uint8ClampedArray
        canvasRender.renderUncompressedData(uncompressedData, image.series_dim_y as number, image.series_dim_z as number, myCanvasRefSagittal, image.sag_aspect, undefined, scale);
        buffer.release();
      }

      if (cor_ndarray) {
        // const shape = image.get_3d_shape().toJs();
        // console.log("cor_ndarray")
        const buffer = (cor_ndarray as PyProxyBuffer).getBuffer("u8clamped");
        (cor_ndarray as PyProxyBuffer).destroy();
        const uncompressedData = buffer.data as Uint8ClampedArray
        canvasRender.renderUncompressedData(uncompressedData, image.series_dim_x as number, image.series_dim_z as number, myCanvasRefCorona, image.cor_aspect, undefined, scale);
        buffer.release();
      }
    }



    // } else {
    //   // (ndarray as PyProxy).destroy()
    //   console.log("not render2")
    // }
    // render_rgba_1d_ndarray.destroy();
    // (image.render_rgba_1d_ndarray as PyProxyBuffer).destroy() // 沒用
    // total += 1;
    // } else if (image.has_compressed_data) {
    //   console.log("render compressedData");
    //   const compressed = (image as any).get_compressed_pixel() // compressed_pixel_bytes
    //   const pyBufferData = (compressed as PyProxyBuffer).getBuffer()
    //   compressed.destroy();
    //   // console.log("pyBufferData data type2, ", typeof pyBufferData.data, pyBufferData.data) // Uint8Array
    //   const compressedData = pyBufferData.data as Uint8Array;
    //   canvasRender.renderCompressedData(
    //     compressedData,
    //     image.width as number,
    //     image.height as number,
    //     image.transferSyntaxUID as string,
    //     image.photometric as string,
    //     image.bit_allocated as number,
    //     myCanvasRef
    //   );
    //   pyBufferData.release()
    // } else {
    //   console.log("no uncompressedData & no compressedData")
    // }
    // total += 1;
    // image.destroy();
  }


  const processDicomBuffer = (buffer?: ArrayBuffer, bufferList?: ArrayBuffer[], inheritWindowCenter = false) => {
    if (PyodideDicom.current) {
      // console.log("has imported PyodideDicom class")
      try {
        if (inheritWindowCenter) {
          dicomObj.current = PyodideDicom.current(buffer, bufferList, decompressJPEG, useWindowCenter, useWindowWidth, currNormalizeMode)
        } else {
          dicomObj.current = PyodideDicom.current(buffer, bufferList, decompressJPEG)
        }
      }
      catch {
        alert("pyodide exception: contact maintainer")
        return;
      }
      const image: PyProxyObj = dicomObj.current;
      // console.log(`image:${image}`) // print a lot of message: PyodideDicom(xxxx
      // console.log(`image max:${image.max}`)
      // console.log(`image center:${image.window_center}`) // works !!!

      setModality(image.modality)
      setPhotometric(image.photometric)
      setTransferSyntax(image.transferSyntaxUID)
      setResX(image.width)
      setResY(image.height)
      setNumFrames(image.frame_num)

      // normalization: using global series max in 3d 
      // but https://grimmer.io/dicom-web-viewer/ show axial plan's max on UI
      // now we correct this by using global max/min 
      setPixelMax(image.frame_max ?? image.max_3d)
      setPixelMin(image.frame_min ?? image.min_3d)

      // by default it is referring 1st dicom in series mode
      setWindowCenter(image.window_center)
      setWindowWidth(image.window_width)

      setCurrFrameIndex(1)
      if (currNormalizeMode === NormalizationMode.WindowCenter) {
        // should always (except switch file) go into here since we rest it to windowCenter mode every time
        if (!windowCenter) {
          setUseWindowCenter(image.window_center)
        }
        if (windowWidth) {
          setUseWindowWidth(image.window_width)
        }
      }

      /** original logic is to const res = await pyodide.runPythonAsync, then res.toJs(1) !! v0.18 use toJs({depth : n})
       * now changes to use a Python object instance in JS !!
       */

      // if (image.ds) {
      // console.log("image ds:", image.ds) // target: PyProxyClass
      // console.log(image.ds) // Proxy
      // console.log(typeof image.ds) // object
      // console.log(`PhotometricInterpretation: ${(image.ds as PyProxy).PhotometricInterpretation}`) // works
      // }

      setIsCommonAxialView(image.is_common_axial_direction)

      if (bufferList) {
        setTotalFiles(image.series_dim_z)
        setTotalCoronaFrames(image.series_dim_y)
        setTotalSagittalFrames(image.series_dim_x)

        // might be duplicate set (if actively drage slider for first time and setup here for 2nd time 
        // but it is fine)  
        setCurrFileNo(image.series_z + 1)
        setCurrentCoronaNo(image.series_y + 1)
        setCurrentSagittalNo(image.series_x + 1)



        const ax_ndarray = image.get_ax_ndarray()
        renderFrame({ ax_ndarray });
        const sag_ndarray = image.get_sag_ndarray()
        renderFrame({ sag_ndarray });
        const cor_ndarray = image.get_cor_ndarray()
        renderFrame({ cor_ndarray });

        // console.log(image.series_dim_y, image.series_dim_x, image.series_y, image.series_x)
        // TODO: setCurrFilePath ??????????
      } else {
        const ndarray = image.get_rgba_1d_ndarray() //render_rgba_1d_ndarray
        // console.log("get_rgba_1d_ndarray:", ndarray)
        renderFrame({ ndarray })
      }
    } else {
      console.log("has not imported PyodideDicom class, ignore")
    }

  }



  const resetUI = () => {
    canvasRender.resetCanvas(myCanvasRef.current)
    canvasRender.resetCanvas(myCanvasRefSagittal.current)
    canvasRender.resetCanvas(myCanvasRefCorona.current)

    if (dicomObj.current) {
      dicomObj.current.destroy()
      dicomObj.current = null
    }

    setCurrNormalizeMode(NormalizationMode.WindowCenter)
    setUseWindowCenter(undefined)
    setUseWindowWidth(undefined)
    setCurrFrameIndex(1)
    setNumFrames(1)
  };

  const loadFile = async (file: File | string, inheritWindowCenter = false) => {
    // if (!checkIfValidDicomFileName(file.name)) {
    //   return
    // }

    // setCurrFilePath(file.name)
    let buffer;
    if (typeof file === "string") {
      buffer = await fetchDicomFileAsync(file)
    } else {
      buffer = await loadDicomFileAsync(file);
    }
    // fileBuffer.current = buffer
    // NOTE: besides getting return value (python code last line expression),
    // python data can be retrieved by accessing python global object:
    // pyodide.globals.get("image")
    // console.log("start to use python to parse parse dicom data");

    processDicomBuffer(buffer, undefined, inheritWindowCenter)
  }

  const fileName = (file: File | string) => {
    return typeof file === "string" ? file : file.name
  }

  // loadSeriesFilesToRender or fetchFile
  const renderFiles = async (files: File[] | string[], seriesMode: SeriesMode) => {

    resetUI();

    // console.log("ifShowSagittalCoronal:", ifShowSagittalCoronal)
    if (!files || files.length === 0) {
      return
    }
    if (seriesMode === SeriesMode.Series) {
      // console.log("3d mode1")
      /** ~ loadFile */
      const promiseList: any[] = [];
      files.forEach((file, index) => {
        if (typeof file === "string") {
          promiseList.push(fetchDicomFileAsync(file));
        } else {
          promiseList.push(loadDicomFileAsync(file));
        }
      });
      const bufferList = await Promise.all(promiseList);
      processDicomBuffer(undefined, bufferList)
    } else {

      const file = files[0];
      setTotalFiles(files.length)

      setCurrFileNo(1)
      setCurrFilePath(fileName(file))
      loadFile(file);
    }
  }

  const onDropFiles = useCallback(async (acceptedFiles?: File[]) => {

    if (acceptedFiles && acceptedFiles.length > 0) {
      acceptedFiles.sort((a: any, b: any) => {
        return a.name.localeCompare(b.name);
      });

      files.current = acceptedFiles.filter((file) => {
        return checkIfValidDicomFileName(file.name);
      })

      if (files.current.length > 0) {
        renderFiles(files.current, ifShowSagittalCoronal)
      }
    }
    // Do something with the files
  }, [ifShowSagittalCoronal]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onDropFiles,
  });

  const handleNormalizeModeChange = useCallback((
    e: React.FormEvent<HTMLInputElement>,
    data: CheckboxProps
  ) => {

    const image: PyProxyObj = dicomObj.current
    if (!image || (!image.width && !image.series_dim_x)) {
      // since we reset the mode to window center/width when loading a new file(s), 
      // -> some files do not have other mode (hidden), so it is more safe to avoid this
      // so pre-switch is invalid 
      return
    }

    const { value } = data;

    const normalize_mode = value as number;
    setCurrNormalizeMode(normalize_mode)

    // if (normalize_mode === NormalizationMode.WindowCenter) {
    //   // console.log(`new is center:${windowCenter}`)
    //   setUseWindowCenter(windowCenter)
    //   setUseWindowWidth(windowWidth)

    //   const image: PyProxyObj = dicomObj.current
    //   if (ifShowSagittalCoronal === SeriesMode.Series) {
    //     dicomObj.current.render_axial_view.callKwargs({
    //       normalize_window_center: windowCenter, normalize_window_width: windowWidth,
    //       normalize_mode: NormalizationMode.WindowCenter
    //     });
    //     dicomObj.current.redner_sag_view.callKwargs({
    //       normalize_window_center: windowCenter, normalize_window_width: windowWidth,
    //       normalize_mode: NormalizationMode.WindowCenter
    //     });
    //     dicomObj.current.redner_cor_view.callKwargs({
    //       normalize_window_center: windowCenter, normalize_window_width: windowWidth,
    //       normalize_mode: NormalizationMode.WindowCenter
    //     });
    //   } else {
    //     image.render_frame_to_rgba_1d(windowCenter, windowWidth, NormalizationMode.WindowCenter)
    //   }
    // } else 

    let normalize_window_center = undefined;
    let normalize_window_width = undefined;

    if (normalize_mode === NormalizationMode.Pixel_MaxMin_Mode) {
      // console.log("new is maxmin")
      // if (ifShowSagittalCoronal === SeriesMode.Series) {
      //   image.render_axial_view.callKwargs({
      //     normalize_mode
      //   });
      //   image.redner_sag_view.callKwargs({
      //     normalize_mode
      //   });
      //   image.redner_cor_view.callKwargs({
      //     normalize_mode
      //   });
      // } else {
      //   image.render_frame_to_rgba_1d.callKwargs({ normalize_mode })
      // }
      // pixelMax =
      //  pixelMin =
      if (pixelMax && pixelMin) {
        const tmpCenter = Math.floor(pixelMax + pixelMin) / 2
        const tmpWidth = Math.floor(pixelMax - pixelMin)

        // this is to let peple can jumpt to max/min mode then use mouse 
        // move and use current pair to adjust window center/width
        setUseWindowCenter(tmpCenter)
        setUseWindowWidth(tmpWidth)
      }
    } else {

      if (normalize_mode === NormalizationMode.WindowCenter) {
        normalize_window_center = windowCenter;
        normalize_window_width = windowWidth;
      } else {
        const data = WindowCenterWidthConst[normalize_mode];
        const tmpWindowCenter = data.L;
        const tmpWindowWidth = data.W;

        normalize_window_center = tmpWindowCenter;
        normalize_window_width = tmpWindowWidth;
      }

      setUseWindowCenter(normalize_window_center)
      setUseWindowWidth(normalize_window_width)
    }

    if (ifShowSagittalCoronal === SeriesMode.Series) {
      const ax_ndarray = image.render_axial_view.callKwargs({
        normalize_window_center, normalize_window_width,
        normalize_mode
      });
      renderFrame({ ax_ndarray })
      const sag_ndarray = image.redner_sag_view.callKwargs({
        normalize_window_center, normalize_window_width,
        normalize_mode
      });
      renderFrame({ sag_ndarray })
      const cor_ndarray = image.redner_cor_view.callKwargs({
        normalize_window_center, normalize_window_width,
        normalize_mode
      });
      renderFrame({ cor_ndarray })
    } else {
      const ndarray = image.render_frame_to_rgba_1d.callKwargs({
        normalize_window_center, normalize_window_width,
        normalize_mode
      })
      renderFrame({ ndarray })
    }
  }, [windowCenter, windowWidth]);

  let info = ""
  info += ` modality:${modality}; photometric:${photometric}; transferSyntax:${transferSyntax};`;
  info += ` resolution:${resX && resY ? (resX.toString() + "x" + resY.toString()) : ""}`;

  const frameIndexes: any[] = Array.from({ length: numFrames }, (_, i) => i + 1)

  const options = Array.from({ length: 10 }, (_, i) => {
    return {
      key: i + 1,
      text: i + 1,
      value: i + 1
    }
  })

  const handleSwitchFrame = (
    e: React.SyntheticEvent<HTMLElement, Event>,
    obj: DropdownProps
  ) => {
    const value = obj.value as number;

    console.log("switch frame:", value, currFrameIndex);

    if (value !== currFrameIndex) {
      setCurrFrameIndex(value)
      const image: PyProxyObj = dicomObj.current
      const ndarray = image.render_frame_to_rgba_1d.callKwargs({ frame_index: value - 1 })
      setPixelMax(image.frame_max)
      setPixelMin(image.frame_min)
      // const ndarray = image.get_rgba_1d_ndarray()
      renderFrame({ ndarray })
    }
  };

  const switchSagittal = (value: number) => {
    // ISSUE: when first time loading series, it will be trigger so sagittal redner twice
    // console.log("switchSagittal")

    setCurrentSagittalNo(value)
    const sag_ndarray = dicomObj.current.redner_sag_view(value - 1)
    renderFrame({ sag_ndarray })
  }

  const switchCorona = (value: number) => {
    // console.log("switch cor")
    // ISSUE: when first time loading series, it will be trigger so sagittal redner twice

    setCurrentCoronaNo(value)
    const cor_ndarray = dicomObj.current.redner_cor_view(value - 1)
    renderFrame({ cor_ndarray })
  }



  const switchFile = (value: number) => {
    // this.setState({
    //   currFileNo: value,
    // });

    if (ifShowSagittalCoronal === SeriesMode.NoSeries) {
      setCurrFileNo(value)

      // const { ifShowSagittalCoronal } = this.state;
      // // console.log("ifShowSagittalCoronal:", ifShowSagittalCoronal);
      // if (ifShowSagittalCoronal) {
      //   this.buildAxialView(
      //     this.currentSeries,
      //     this.currentSeriesImageObjects,
      //     value - 1
      //   );
      // } else {
      const newFile = files.current[value - 1];
      // console.log("switch to image:", value, newFile);
      // if (!this.isOnlineMode) {
      setCurrFilePath(fileName(newFile))
      loadFile(newFile, true);
      // } else {
      //   this.fetchFile(newFile);
      // }
      // }
    } else {
      setCurrFileNo(value)
      const ax_ndarray = dicomObj.current.render_axial_view(value - 1)
      renderFrame({ ax_ndarray })
    }
  };

  const onKeyDown = (keyName: string) => {
    // const { totalFiles, currFileNo } = this.state;
    let newFileNo = currFileNo;
    if (totalFiles > 1) {
      if (keyName === "right") {
        newFileNo += 1;
        if (newFileNo > totalFiles) {
          return;
        }
      } else if (keyName === "left") {
        newFileNo -= 1;
        if (newFileNo < 1) {
          return;
        }
      }
    } else {
      return;
    }

    switchFile(newFileNo);
  };

  const handleSeriesModeChange = async (e: any, obj: any) => {
    const { value } = obj;
    console.log("handleSeriesModeChange:", value)

    let seriesMode;
    if (ifShowSagittalCoronal === SeriesMode.NoSeries) {
      seriesMode = SeriesMode.Series;
      console.log("to series:", value)
      setIfShowSagittalCoronal(seriesMode)

      maxViewWidth.current = MAX_WIDTH_SERIES_MODE
      maxViewHeight.current = MAX_HEIGHT_SERIES_MODE

    } else {
      console.log("to no series", value)
      seriesMode = SeriesMode.NoSeries;

      maxViewWidth.current = MAX_WIDTH_SINGLE_MODE
      maxViewHeight.current = MAX_HEIGHT_SINGLE_MODE

      setIfShowSagittalCoronal(SeriesMode.NoSeries)
      // if (files.current.length > 0) {
      //   const file = files.current[0];
      //   setTotalFiles(files.current.length)
      //   setCurrFileNo(1)
      //   // if (this.isOnlineMode) {
      //   setCurrFilePath(file.name)
      //   loadFile(file);
      // }
    }

    renderFiles(files.current, seriesMode)
  }

  const axisLabel = (char: string) => {
    return (isCommonAxialView ? <div>{char}</div> : <div>{" "}</div>)
  }

  return (
    <Hotkeys
      allowRepeat
      keyName="right,left"
      onKeyDown={onKeyDown}
    >
      <div className="flex-container">
        <div>
          <div className="flex-container">
            <div>
              DICOM Image Viewer (feat: 1. click a DICOM file url to view 2. click extension
              icon (or ctrl+u/cmd+u) to open <br></br>viewer page 3.
              <a href="https://github.com/grimmer0125/dicom-web-viewer/wiki">
                {" "}
                More (e.g. use CLI to open files & Instruction)!
              </a>
            </div>
          </div>
          <div>
            <div className="flex-container">
              <div style={dropZoneStyle} {...getRootProps()} className="flex-column_align-center">
                <input {...getInputProps()} />
                <div style={{ width: "80%" }}>
                  {isDragActive ? (
                    <p>Drop the DICOM files/folder here ...</p>
                  ) : (
                    <p>
                      {" "}
                      To access DICOM local files, <br /> 1) drop DICOM files/folder here, <br />
                      2) click here to select files to view. <br />
                      3) drag files into Chrome without opening viewer first, to allow this feature,
                      you need to enable file url access in extenstion DETAILS
                      setting page.
                      <br /> To swtich files, use slider or right/left key.
                      <br /> To change window center (level), use mouse press+move
                      {isPyodideLoading ? <><br /> <b>Loading python runtime</b> </> : null}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <div className="flex-container">
              {info}
              <br />
              {` current window_center:${useWindowCenter ?? ""} ; window_width ${useWindowWidth ?? ""} ;`}
              {` ${modality === "CT" ? "HU" : "pixel"} max:${pixelMax ?? ""}, min:${pixelMin ?? ""} ;`}
              {/* {` file: ${currFilePath} ;`} */}
            </div>
            <div className="flex-container">
              <NormalizationComponent
                mode={NormalizationMode.WindowCenter}
                windowItem={
                  (windowCenter !== undefined && windowWidth !== undefined)
                    ? { L: windowCenter, W: windowWidth }
                    : undefined
                }
                currNormalizeMode={currNormalizeMode}
                onChange={handleNormalizeModeChange}
              />

              <NormalizationComponent
                mode={NormalizationMode.Pixel_MaxMin_Mode}
                currNormalizeMode={currNormalizeMode}
                onChange={handleNormalizeModeChange}
              />
              <div>
                {numFrames > 1 ? (
                  <Dropdown
                    placeholder="Switch Frame"
                    selection
                    onChange={handleSwitchFrame}
                    options={options}
                  />) : null}
              </div>
            </div>
            <div className="flex-container">
              {modality === "CT" && (
                <>
                  <NormalizationComponent
                    mode={NormalizationMode.AbdomenSoftTissues}
                    currNormalizeMode={currNormalizeMode}
                    onChange={handleNormalizeModeChange}
                  />
                  <NormalizationComponent
                    mode={NormalizationMode.SpineSoftTissues}
                    currNormalizeMode={currNormalizeMode}
                    onChange={handleNormalizeModeChange}
                  />

                  <NormalizationComponent
                    mode={NormalizationMode.SpineBone}
                    currNormalizeMode={currNormalizeMode}
                    onChange={handleNormalizeModeChange}
                  />
                  <NormalizationComponent
                    mode={NormalizationMode.Brain}
                    currNormalizeMode={currNormalizeMode}
                    onChange={handleNormalizeModeChange}
                  />
                  <NormalizationComponent
                    mode={NormalizationMode.Lungs}
                    currNormalizeMode={currNormalizeMode}
                    onChange={handleNormalizeModeChange}
                  />
                </>)}
            </div>
            <div className="flex-container">
              <Radio
                toggle
                value={SeriesMode[ifShowSagittalCoronal]}
                checked={ifShowSagittalCoronal === SeriesMode.Series}
                onChange={handleSeriesModeChange}
              />
              {"  Series mode"}
            </div>
          </div>
          {totalFiles > 0 ? (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
              }}
            >
              <div style={{ width: 600 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                  }}
                >
                  {`${currFilePath}. ${currFileNo}/${totalFiles}`}
                </div>
                <div className="flex-container">
                  {axisLabel("S")}
                  <Slider
                    value={currFileNo}
                    step={1}
                    min={1}
                    max={totalFiles}
                    onChange={switchFile}
                  />
                  {axisLabel("I")}
                </div>
                {ifShowSagittalCoronal === SeriesMode.Series && (
                  <>
                    <div className="flex-container">
                      {axisLabel("R")}
                      <Slider
                        value={currentSagittalNo}
                        step={1}
                        min={1}
                        max={totalSagittalFrames}
                        onChange={switchSagittal}
                      />
                      {axisLabel("L")}
                    </div>
                    <div className="flex-container">
                      {axisLabel("A")}
                      <Slider
                        value={currentCoronaNo}
                        step={1}
                        min={1}
                        max={totalCoronaFrames}
                        onChange={switchCorona}
                      />
                      {axisLabel("P")}
                    </div>
                  </>
                )}
              </div>
            </div>) : null}
          <div className="flex-container">
            <div className="flex-column-justify-align-center">
              {axisLabel("A")}
              <div className="flex-column_align-center">
                {axisLabel("R")}
                {/* Axial */}
                <canvas
                  ref={myCanvasRef}
                  onMouseDown={onMouseCanvasDown}
                  onMouseMove={onMouseMove}
                  // onMouseUp={onMouseUp}
                  width={MAX_WIDTH_SERIES_MODE}
                  height={MAX_HEIGHT_SERIES_MODE}
                  style={{ backgroundColor: "black" }}
                />
                {axisLabel("L")}
              </div>
              {axisLabel("P")}
            </div>
            {ifShowSagittalCoronal === SeriesMode.Series && (
              <>
                <div className="flex-column-justify-align-center">
                  {axisLabel("S")}
                  <div className="flex-column_align-center">
                    {axisLabel("A")}
                    {/* Sagittal */}
                    <canvas
                      ref={myCanvasRefSagittal}
                      onMouseDown={onMouseCanvasDown}
                      onMouseMove={onMouseMove}
                      width={MAX_WIDTH_SERIES_MODE}
                      height={MAX_HEIGHT_SERIES_MODE}
                      style={{ backgroundColor: "yellow" }}
                    />
                    {axisLabel("P")}
                  </div>
                  {axisLabel("I")}
                </div>
                <div className="flex-column-justify-align-center">
                  {axisLabel("S")}
                  <div className="flex-column_align-center">
                    {/* Corona */}
                    {axisLabel("R")}
                    <canvas
                      ref={myCanvasRefCorona}
                      onMouseDown={onMouseCanvasDown}
                      onMouseMove={onMouseMove}
                      width={MAX_WIDTH_SERIES_MODE}
                      height={MAX_HEIGHT_SERIES_MODE}
                      style={{ backgroundColor: "green" }}
                    />
                    {axisLabel("L")}
                  </div>
                  {axisLabel("I")}
                </div>
              </>)}
          </div>
        </div>
      </div >
    </Hotkeys>
  );
}

export default App;
